import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  StyleSheet, Text, View, SafeAreaView, Platform, Alert, AppState, Share,
  ImageBackground, Modal, ScrollView, TextInput, Dimensions, TouchableOpacity
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Rect, Line, Text as SvgText, G } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSequence, withTiming, withRepeat
} from 'react-native-reanimated';
import { db } from './firebase';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';

const STORAGE_KEY = 'meir_baby_state';
const HISTORY_KEY = 'meir_baby_history_v2';
const EVENTS_KEY = 'meir_baby_events';
const SCREEN_WIDTH = Dimensions.get('window').width;

interface SavedState {
  isSleeping: boolean;
  isPlaying?: boolean;
  sleepStartTime: number | null;
  wakeStartTime: number | null;
  playStartTime?: number | null;
  lastSleepDuration: number;
  totalPlayToday?: number;
  totalSleepToday: number;
  sleepCountToday: number;
  lastDate: string;
  babyName: string;
  babyId?: string;
  sleepGoalHours: number;
  playGoalHours?: number;
  resetHour: number;
}

interface DayHistory {
  date: string;
  totalSleep: number;
  totalPlay: number;
  sleepCount: number;
}

interface SleepEvent {
  type: 'נרדם' | 'התעורר';
  time: string;
  date: string;
  duration?: string | null;
}

const getToday = (resetHour: number) => {
  const now = new Date();
  if (now.getHours() < resetHour) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return yesterday.toDateString();
  }
  return now.toDateString();
};

const formatTime = (seconds: number) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (seconds < 60) return `00:00:${secs.toString().padStart(2, '0')}`;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
};

const formatHoursDecimal = (seconds: number) => (seconds / 3600).toFixed(1);

const formatExactTime = (date: Date) =>
  `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

const eventSortKey = (e: { date: string; time: string }) => {
  const [day, month, year] = e.date.split('.').map(Number);
  const [hours, minutes] = e.time.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes).getTime();
};

const formatDateShort = (dateStr: string) => {
  const d = new Date(dateStr);
  return ["א'","ב'","ג'","ד'","ה'","ו'","ש'"][d.getDay()];
};

const formatDateHebrew = (dateStr: string) => {
  const d = new Date(dateStr);
  const days = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  return `יום ${days[d.getDay()]} ${d.getDate()}/${d.getMonth()+1}`;
};

// אישור Web במקום Alert
const webConfirm = (message: string, onConfirm: () => void) => {
  if (Platform.OS === 'web') {
    if (window.confirm(message)) onConfirm();
  } else {
    Alert.alert('אישור', message, [
      { text: 'ביטול', style: 'cancel' },
      { text: 'אישור', style: 'destructive', onPress: onConfirm },
    ]);
  }
};

function WeeklyChart({ data, goalHours }: { data: DayHistory[], goalHours: number }) {
  const chartWidth = Math.min(SCREEN_WIDTH - 80, 340);
  const chartHeight = 120;
  const maxVal = Math.max(goalHours * 3600, ...data.map(d => d.totalSleep));
  const barWidth = (chartWidth / 7) * 0.6;
  const gap = (chartWidth / 7) * 0.4;
  const goalY = chartHeight - (goalHours * 3600 / maxVal) * chartHeight;
  const last7 = [...data].slice(0, 7).reverse();
  while (last7.length < 7) last7.unshift({ date: '', totalSleep: 0, totalPlay: 0, sleepCount: 0 });

  return (
    <Svg width={chartWidth} height={chartHeight + 24}>
      <Line x1={0} y1={goalY} x2={chartWidth} y2={goalY} stroke="#2ecc71" strokeWidth={1} strokeDasharray="4,4" />
      {last7.map((day, i) => {
        const barH = day.totalSleep > 0 ? (day.totalSleep / maxVal) * chartHeight : 2;
        const x = i * (chartWidth / 7) + gap / 2;
        const y = chartHeight - barH;
        const isGoalMet = day.totalSleep >= goalHours * 3600;
        return (
          <G key={i}>
            <Rect x={x} y={y} width={barWidth} height={barH} rx={4}
              fill={day.totalSleep === 0 ? '#2a2a4a' : isGoalMet ? '#2ecc71' : '#3498DB'}
              opacity={day.totalSleep === 0 ? 0.3 : 1} />
            <SvgText x={x + barWidth/2} y={chartHeight+16} fontSize={10} fill="rgba(255,255,255,0.6)" textAnchor="middle">
              {day.date ? formatDateShort(day.date) : ''}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

export default function App() {
  const isSleepingRef = useRef(false);
  const sleepStartTimeRef = useRef<number | null>(null);
  const wakeStartTimeRef = useRef<number | null>(null);
  const totalSleepTodayRef = useRef(0);
  const sleepCountTodayRef = useRef(0);
  const currentDateRef = useRef('');
  const resetHourRef = useRef(20);
  const isLocalUpdateRef = useRef(false);
  const historyRef = useRef<DayHistory[]>([]);
  const sleepEventsRef = useRef<SleepEvent[]>([]);
  const babyIdRef = useRef('meir');

  const [isSleeping, setIsSleeping] = useState(false);
  const [lastSleepDuration, setLastSleepDuration] = useState(0);
  const [displaySleepTime, setDisplaySleepTime] = useState(0);
  const [displayWakeTime, setDisplayWakeTime] = useState(0);
  const [displayTotalSleep, setDisplayTotalSleep] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [babyName, setBabyName] = useState('מאיר');
  const [sleepGoalHours, setSleepGoalHours] = useState(15);
  const [resetHour, setResetHour] = useState(20);
  const [showSettings, setShowSettings] = useState(false);
  const [tempBabyName, setTempBabyName] = useState('מאיר');
  const [tempSleepGoal, setTempSleepGoal] = useState('15');
  const [tempResetHour, setTempResetHour] = useState('20');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<DayHistory[]>([]);
  const [sleepEvents, setSleepEvents] = useState<SleepEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [showEditStart, setShowEditStart] = useState(false);
  const [editStartTime, setEditStartTime] = useState('');
  const [manualStartTime, setManualStartTime] = useState('');
  const [manualEndTime, setManualEndTime] = useState('');
  const [isOffline, setIsOffline] = useState(false);
  const [showEditEvent, setShowEditEvent] = useState(false);
  const [editEventIndex, setEditEventIndex] = useState(-1);
  const [editEventTime, setEditEventTime] = useState('');
  const [manualDate, setManualDate] = useState('');
  const sleepScale = useSharedValue(1);
  const sleepAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: sleepScale.value }] }));
  const pulseScale = useSharedValue(1);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulseScale.value }] }));

  const saveHistoryToStorage = async (newHistory: DayHistory[]) => {
    try { await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory)); } catch (e) { console.error(e); }
  };

  const backupToFirebase = async (h: DayHistory[]) => {
    try {
      await setDoc(doc(db, 'babies', babyIdRef.current), { lastBackup: new Date().toISOString(), history: h }, { merge: true });
      setIsOffline(false);
    } catch (e) { setIsOffline(true); console.error(e); }
  };

  const saveDayToHistory = (date: string, totalSleep: number, totalPlay: number, sleepCount: number) => {
    const current = historyRef.current;
    const existing = current.findIndex(d => d.date === date);
    let updated: DayHistory[];
    if (existing >= 0) {
      updated = [...current];
      updated[existing] = { date, totalSleep, totalPlay, sleepCount };
    } else {
      updated = [{ date, totalSleep, totalPlay, sleepCount }, ...current].slice(0, 30);
    }
    historyRef.current = updated;
    setHistory(updated);
    saveHistoryToStorage(updated);
    return updated;
  };

  const saveState = async (extraData?: Partial<SavedState>) => {
    const state: SavedState = {
      isSleeping: isSleepingRef.current,
      sleepStartTime: sleepStartTimeRef.current,
      wakeStartTime: wakeStartTimeRef.current,
      lastSleepDuration: 0,
      totalSleepToday: totalSleepTodayRef.current,
      sleepCountToday: sleepCountTodayRef.current,
      lastDate: getToday(resetHourRef.current),
      babyName,
      babyId: babyIdRef.current,
      sleepGoalHours,
      resetHour: resetHourRef.current,
      ...extraData,
    };
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      isLocalUpdateRef.current = true;
      await setDoc(doc(db, 'babies', babyIdRef.current), state, { merge: true });
      setIsOffline(false);
      setTimeout(() => { isLocalUpdateRef.current = false; }, 2000);
    } catch (e) {
      setIsOffline(true);
      console.error(e);
    }
  };

  const applyState = (state: SavedState) => {
    if (state.babyId) babyIdRef.current = state.babyId;
    const rh = state.resetHour ?? 20;
    const today = getToday(rh);
    const isNewDay = state.lastDate !== today;
    const totalSleep = isNewDay ? 0 : (state.totalSleepToday ?? 0);
    const sleepCount = isNewDay ? 0 : (state.sleepCountToday ?? 0);

    isSleepingRef.current = state.isSleeping;
    sleepStartTimeRef.current = state.sleepStartTime;
    wakeStartTimeRef.current = state.wakeStartTime;
    totalSleepTodayRef.current = totalSleep;
    sleepCountTodayRef.current = sleepCount;
    currentDateRef.current = today;
    resetHourRef.current = rh;

    setIsSleeping(state.isSleeping);
    setLastSleepDuration(state.lastSleepDuration);
    setBabyName(state.babyName ?? 'מאיר');
    setSleepGoalHours(state.sleepGoalHours ?? 15);
    setResetHour(rh);
    setTempBabyName(state.babyName ?? 'מאיר');
    setTempSleepGoal(String(state.sleepGoalHours ?? 15));
    setTempResetHour(String(rh));

    const now = Date.now();
    if (state.isSleeping && state.sleepStartTime) {
      const currentSleep = Math.floor((now - state.sleepStartTime) / 1000);
      setDisplaySleepTime(currentSleep);
      setDisplayTotalSleep(totalSleep + currentSleep);
    } else {
      setDisplayTotalSleep(totalSleep);
    }
    if (!state.isSleeping && state.wakeStartTime) setDisplayWakeTime(Math.floor((now - state.wakeStartTime) / 1000));
    if (isNewDay && state.totalSleepToday > 0) {
      saveDayToHistory(state.lastDate, state.totalSleepToday, state.totalPlayToday ?? 0, state.sleepCountToday ?? 0);
    }
  };

  useEffect(() => {
    const loadState = async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved) applyState(JSON.parse(saved));
        else currentDateRef.current = getToday(20);
        const savedHistory = await AsyncStorage.getItem(HISTORY_KEY);
        if (savedHistory) { const h = JSON.parse(savedHistory); historyRef.current = h; setHistory(h); }
        const savedEvents = await AsyncStorage.getItem(EVENTS_KEY);
        if (savedEvents) { const ev = JSON.parse(savedEvents); sleepEventsRef.current = ev; setSleepEvents(ev); }
      } catch (e) { console.error(e); } finally { setIsLoaded(true); }
      }; loadState();
      const unsubscribe = onSnapshot(doc(db, 'babies', babyIdRef.current), (snapshot) => {
  if (snapshot.exists() && !isLocalUpdateRef.current) {
  const data = snapshot.data();
  applyState(data as SavedState);
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  if (data.events) {
    sleepEventsRef.current = data.events;
    setSleepEvents(data.events);
    AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(data.events));
  }
  if (data.history) {
    historyRef.current = data.history;
    setHistory(data.history);
    AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(data.history));
  }
  }
});
return () => unsubscribe();
    
    
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const today = getToday(resetHourRef.current);
      if (today !== currentDateRef.current && currentDateRef.current !== '') {
        const updated = saveDayToHistory(currentDateRef.current, totalSleepTodayRef.current, 0, sleepCountTodayRef.current);
        backupToFirebase(updated);
        currentDateRef.current = today;
        totalSleepTodayRef.current = 0; sleepCountTodayRef.current = 0;
        isSleepingRef.current = false;
        setIsSleeping(false); setDisplayTotalSleep(0);
        return;
      }
      if (isSleepingRef.current && sleepStartTimeRef.current) {
        const currentSleep = Math.floor((now - sleepStartTimeRef.current) / 1000);
        setDisplaySleepTime(currentSleep);
        setDisplayTotalSleep(totalSleepTodayRef.current + currentSleep);
      }
      if (!isSleepingRef.current && wakeStartTimeRef.current) setDisplayWakeTime(Math.floor((now - wakeStartTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        backupToFirebase(historyRef.current);
      }
    });
    return () => sub.remove();
  }, []);

  const addSleepEvent = async (type: 'נרדם' | 'התעורר', duration?: string) => {
    const now = new Date();
    const event: SleepEvent = { type, time: formatExactTime(now), date: now.toLocaleDateString('he-IL'), duration: duration ?? null };
    const updated = [event, ...sleepEventsRef.current].slice(0, 50);
    sleepEventsRef.current = updated;
    setSleepEvents(updated);
    AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(updated));
    setDoc(doc(db, 'babies', babyIdRef.current), { events: updated }, { merge: true })
      .then(() => setIsOffline(false))
      .catch(() => setIsOffline(true));
  };

  const toggleSleep = async () => {
    const now = Date.now();
    if (isSleepingRef.current) {
      const sleptFor = sleepStartTimeRef.current ? Math.floor((now - sleepStartTimeRef.current) / 1000) : 0;
      const newTotalSleep = totalSleepTodayRef.current + sleptFor;
      isSleepingRef.current = false;
      sleepStartTimeRef.current = null; wakeStartTimeRef.current = now;
      totalSleepTodayRef.current = newTotalSleep;
      setIsSleeping(false); setLastSleepDuration(sleptFor); setDisplayWakeTime(0);
      pulseScale.value = withTiming(1, { duration: 200 });
      await addSleepEvent('התעורר', formatTime(sleptFor));
      saveDayToHistory(currentDateRef.current, newTotalSleep, 0, sleepCountTodayRef.current);
      saveState();
    } else {
      const newCount = sleepCountTodayRef.current + 1;
      isSleepingRef.current = true; sleepStartTimeRef.current = now;
      sleepCountTodayRef.current = newCount;
      setIsSleeping(true); setDisplaySleepTime(0);
      pulseScale.value = withRepeat(withSequence(withTiming(1.08, { duration: 900 }), withTiming(1, { duration: 900 })), 3, false);
      await addSleepEvent('נרדם');
      saveState();
    }
  };
  // הוספת שינה ידנית (מהגן)
  const addManualSleepSession = () => {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(manualStartTime) || !timeRegex.test(manualEndTime)) {
      alert('יש להזין שעות בפורמט מדויק של HH:MM (לדוגמה 14:30)');
      return;
    }

    // Parse session date
    let sessionDate: Date;
    if (manualDate && /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(manualDate)) {
      const [d, m, y] = manualDate.split('.').map(Number);
      sessionDate = new Date(y, m - 1, d);
    } else {
      sessionDate = new Date();
    }

    const [startH, startM] = manualStartTime.split(':').map(Number);
    const [endH, endM] = manualEndTime.split(':').map(Number);

    const startDate = new Date(sessionDate);
    startDate.setHours(startH, startM, 0, 0);
    const endDate = new Date(sessionDate);
    endDate.setHours(endH, endM, 0, 0);

    let durationSeconds = Math.floor((endDate.getTime() - startDate.getTime()) / 1000);
    if (durationSeconds < 0) durationSeconds += 24 * 3600;

    const dateStr = sessionDate.toLocaleDateString('he-IL');
    const historyDateStr = sessionDate.toDateString();
    const isToday = historyDateStr === currentDateRef.current;

    if (isToday) {
      const newTotalSleep = totalSleepTodayRef.current + durationSeconds;
      const newCount = sleepCountTodayRef.current + 1;
      totalSleepTodayRef.current = newTotalSleep;
      sleepCountTodayRef.current = newCount;
      setDisplayTotalSleep(newTotalSleep);
      setLastSleepDuration(durationSeconds);
      saveDayToHistory(historyDateStr, newTotalSleep, 0, newCount);
    } else {
      const existing = historyRef.current.find(d => d.date === historyDateStr);
      saveDayToHistory(historyDateStr, (existing?.totalSleep ?? 0) + durationSeconds, 0, (existing?.sleepCount ?? 0) + 1);
    }

    const startEvent = { type: 'נרדם' as const, time: manualStartTime, date: dateStr };
    const endEvent = { type: 'התעורר' as const, time: manualEndTime, date: dateStr, duration: formatTime(durationSeconds) };

    const updatedEvents = [endEvent, startEvent, ...sleepEventsRef.current]
      .sort((a, b) => eventSortKey(b) - eventSortKey(a))
      .slice(0, 50);
    sleepEventsRef.current = updatedEvents;
    setSleepEvents(updatedEvents);
    AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(updatedEvents));
    setDoc(doc(db, 'babies', babyIdRef.current), { events: updatedEvents }, { merge: true })
      .then(() => setIsOffline(false))
      .catch(() => setIsOffline(true));

    saveState();
    setShowManualAdd(false);
    setManualStartTime('');
    setManualEndTime('');
    setManualDate('');
  };

  const deleteEvent = (index: number) => {
    const updated = sleepEventsRef.current.filter((_, i) => i !== index);
    sleepEventsRef.current = updated;
    setSleepEvents(updated);
    AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(updated));
    setDoc(doc(db, 'babies', babyIdRef.current), { events: updated }, { merge: true })
      .then(() => setIsOffline(false))
      .catch(() => setIsOffline(true));
  };

  const confirmEditEvent = () => {
    if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(editEventTime)) {
      alert('פורמט לא תקין — נסה שוב (לדוגמה 14:30)');
      return;
    }
    const updated = [...sleepEventsRef.current];
    updated[editEventIndex] = { ...updated[editEventIndex], time: editEventTime };
    updated.sort((a, b) => eventSortKey(b) - eventSortKey(a));
    sleepEventsRef.current = updated;
    setSleepEvents(updated);
    AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(updated));
    setDoc(doc(db, 'babies', babyIdRef.current), { events: updated }, { merge: true })
      .then(() => setIsOffline(false))
      .catch(() => setIsOffline(true));
    setShowEditEvent(false);
  };

  const shareDaySummary = async () => {
    const totalStr = formatTime(displayTotalSleep);
    const pct = Math.round((displayTotalSleep / (sleepGoalHours * 3600)) * 100);
    const count = sleepCountTodayRef.current;
    const dateStr = new Date().toLocaleDateString('he-IL');
    const text = `📊 דוח שינה של ${babyName} — ${dateStr}\n\n😴 סה"כ שינה: ${totalStr}\n🎯 מטרה: ${sleepGoalHours}:00:00 (${pct}%)\n💤 מספר שינות: ${count}`;
    if (Platform.OS === 'web') {
      if ((navigator as any).share) {
        (navigator as any).share({ text });
      } else {
        (navigator as any).clipboard?.writeText(text).then(() => alert('הטקסט הועתק ללוח!'));
      }
    } else {
      Share.share({ message: text });
    }
  };

  // עריכת זמן התחלה של שינה פעילה
  const editActiveStartTime = () => {
  if (!isSleepingRef.current) return;
  const currentStart = new Date(sleepStartTimeRef.current!);
  setEditStartTime(formatExactTime(currentStart));
  setShowEditStart(true);
};

const confirmEditStartTime = () => {
  if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(editStartTime)) {
    alert('פורמט לא תקין — נסה שוב (לדוגמה 14:30)');
    return;
  }
  const [h, m] = editStartTime.split(':').map(Number);
  const newStart = new Date();
  newStart.setHours(h, m, 0, 0);
  sleepStartTimeRef.current = newStart.getTime();
  saveState();
  const updatedEvents = [...sleepEventsRef.current];
  const idx = updatedEvents.findIndex(e => e.type === 'נרדם');
  if (idx !== -1) {
    updatedEvents[idx] = { ...updatedEvents[idx], time: editStartTime };
    sleepEventsRef.current = updatedEvents;
    setSleepEvents(updatedEvents);
    AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(updatedEvents));
    setDoc(doc(db, 'babies', babyIdRef.current), { events: updatedEvents }, { merge: true })
      .then(() => setIsOffline(false))
      .catch(() => setIsOffline(true));
  }
  setShowEditStart(false);
};
  const handleSleepPress = () => {
    sleepScale.value = withSequence(withTiming(0.94, { duration: 80 }), withTiming(1, { duration: 80 }));
    toggleSleep();
  };

  const saveSettings = () => {
    const newSleepGoal = parseFloat(tempSleepGoal) || 15;
    const newResetHour = parseInt(tempResetHour) || 20;
    if (babyIdRef.current === 'meir' && tempBabyName !== babyName) {
      babyIdRef.current = tempBabyName.trim().toLowerCase().replace(/\s+/g, '-') || 'baby';
    }
    setBabyName(tempBabyName); setSleepGoalHours(newSleepGoal); setResetHour(newResetHour);
    resetHourRef.current = newResetHour;
    saveState({ babyName: tempBabyName, babyId: babyIdRef.current, sleepGoalHours: newSleepGoal, resetHour: newResetHour });
    setShowSettings(false);
  };

  const resetAll = () => webConfirm('איפוס כל הנתונים — האם אתה בטוח?', () => {
    isSleepingRef.current = false;
    sleepStartTimeRef.current = null; wakeStartTimeRef.current = null;
    totalSleepTodayRef.current = 0; sleepCountTodayRef.current = 0;
    pulseScale.value = withTiming(1, { duration: 200 });
    setIsSleeping(false); setLastSleepDuration(0);
    setDisplaySleepTime(0); setDisplayWakeTime(0); setDisplayTotalSleep(0);
    saveState();
  });

  const resetSleep = () => webConfirm('איפוס נתוני שינה — האם אתה בטוח?', () => {
    isSleepingRef.current = false; sleepStartTimeRef.current = null;
    totalSleepTodayRef.current = 0; sleepCountTodayRef.current = 0;
    pulseScale.value = withTiming(1, { duration: 200 });
    setIsSleeping(false); setLastSleepDuration(0); setDisplaySleepTime(0); setDisplayTotalSleep(0);
    saveState();
  });

  const resetHistoryAndEvents = () => webConfirm('איפוס יומן והיסטוריה — האם אתה בטוח?', () => {
    historyRef.current = []; sleepEventsRef.current = []; setHistory([]); setSleepEvents([]);
    AsyncStorage.removeItem(HISTORY_KEY); AsyncStorage.removeItem(EVENTS_KEY);
    setDoc(doc(db, 'babies', babyIdRef.current), { events: [], history: [] }, { merge: true })
      .then(() => setIsOffline(false))
      .catch(() => setIsOffline(true));
  });

  const { avgSleepSeconds, avgSleepCount, mostCommonHour } = useMemo(() => {
    const avgSleepSeconds = history.length > 0 ? history.reduce((s, d) => s + d.totalSleep, 0) / history.length : 0;
    const avgSleepCount = history.length > 0 ? history.reduce((s, d) => s + d.sleepCount, 0) / history.length : 0;
    const sleepHoursArr = sleepEvents.filter(e => e.type === 'נרדם').map(e => parseInt(e.time.split(':')[0]));
    const mostCommonHour = sleepHoursArr.length > 0
      ? Number(Object.entries(
          sleepHoursArr.reduce<Record<number, number>>((acc, h) => { acc[h] = (acc[h] ?? 0) + 1; return acc; }, {})
        ).sort((a, b) => b[1] - a[1])[0][0])
      : null;
    return { avgSleepSeconds, avgSleepCount, mostCommonHour };
  }, [history, sleepEvents]);

  const SLEEP_GOAL_SECONDS = sleepGoalHours * 3600;
  const RING_SIZE = 220;
  const STROKE_WIDTH = 12;
  const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const sleepProgress = Math.min(displayTotalSleep / SLEEP_GOAL_SECONDS, 1);
  const strokeDashoffset = CIRCUMFERENCE * (1 - sleepProgress);
  const ringColor = sleepProgress >= 1 ? '#2ecc71' : '#3498DB';
  const bgColor = isSleeping ? '#1a1a4e' : '#1a3a4e';

  if (!isLoaded) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <Text style={styles.loadingText}>טוען...</Text>
      </SafeAreaView>
    );
  }

  const renderModals = () => (
    <>
      <Modal visible={showEvents} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>🕐 יומן שינה</Text>
            {sleepEvents.length === 0 ? <Text style={styles.emptyHistory}>אין אירועים עדיין</Text> : (
              <ScrollView style={{ maxHeight: 400 }}>
                {sleepEvents.map((event, i) => (
                  <View key={i} style={[styles.eventRow, { borderRightWidth: 4, borderRightColor: event.type === 'נרדם' ? '#3498DB' : '#F1C40F' }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.eventType}>{event.type === 'נרדם' ? '😴 נרדם' : `☀️ התעורר${event.duration ? ` — ${event.duration}` : ''}`}</Text>
                      <Text style={styles.eventDate}>{event.date}</Text>
                    </View>
                    <Text style={styles.eventTime}>{event.time}</Text>
                    <TouchableOpacity onPress={() => { setEditEventIndex(i); setEditEventTime(event.time); setShowEditEvent(true); }} style={styles.eventActionBtn}>
                      <Text style={{ fontSize: 15 }}>✏️</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => webConfirm('למחוק אירוע זה?', () => deleteEvent(i))} style={styles.eventActionBtn}>
                      <Text style={{ fontSize: 15 }}>🗑️</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity onPress={() => setShowEvents(false)} style={styles.cancelBtnView}>
              <Text style={styles.cancelBtnText}>סגור</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showHistory} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.statsModalContent}>
            <View style={styles.statsBox}>
              <Text style={styles.statsTitle}>📊 סטטיסטיקות שינה</Text>
              <View style={styles.statsCards}>
                <View style={styles.statCard}>
                  <Text style={styles.statCardNum}>{formatHoursDecimal(avgSleepSeconds)}</Text>
                  <Text style={styles.statCardLabel}>שעות{'\n'}ממוצע יומי</Text>
                </View>
                <View style={styles.statCard}>
                  <Text style={styles.statCardNum}>{avgSleepCount.toFixed(1)}</Text>
                  <Text style={styles.statCardLabel}>שינות{'\n'}ממוצע יומי</Text>
                </View>
                <View style={styles.statCard}>
                  <Text style={styles.statCardNum}>{mostCommonHour !== null ? `${mostCommonHour}:00` : '--'}</Text>
                  <Text style={styles.statCardLabel}>שעה{'\n'}נפוצה לשינה</Text>
                </View>
              </View>
              <Text style={styles.chartTitle}>שינה שבועית</Text>
              <View style={styles.chartLegend}>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#2ecc71' }]} /><Text style={styles.legendText}>הגיע למטרה</Text></View>
                <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: '#3498DB' }]} /><Text style={styles.legendText}>לא הגיע</Text></View>
              </View>
              {history.length === 0 ? <Text style={styles.emptyHistoryDark}>אין נתונים עדיין</Text> : <WeeklyChart data={history} goalHours={sleepGoalHours} />}
              <Text style={styles.chartTitle}>פירוט ימים</Text>
              {history.length === 0 ? <Text style={styles.emptyHistoryDark}>הנתונים יישמרו בסוף כל יום</Text> : (
                history.map((day, i) => (
                  <View key={i} style={styles.historyRow}>
                    <Text style={styles.historyDate}>{formatDateHebrew(day.date)}</Text>
                    <View style={styles.historyStats}>
                      <View style={styles.historyStat}>
                        <Text style={[styles.historyStatNum, day.totalSleep >= sleepGoalHours * 3600 && { color: '#2ecc71' }]}>{formatTime(day.totalSleep)}</Text>
                        <Text style={styles.historyStatLabel}>שינה</Text>
                      </View>
                      <View style={styles.historyStat}>
                        <Text style={styles.historyStatNum}>{day.sleepCount}</Text>
                        <Text style={styles.historyStatLabel}>פעמים</Text>
                      </View>
                      <View style={styles.historyStat}>
                        <Text style={styles.historyStatNum}>{formatTime(day.totalPlay)}</Text>
                        <Text style={styles.historyStatLabel}>פעילות</Text>
                      </View>
                    </View>
                  </View>
                ))
              )}
              <TouchableOpacity onPress={() => setShowHistory(false)} style={styles.cancelBtnDarkView}>
                <Text style={styles.cancelBtnDarkText}>סגור</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={showSettings} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>⚙️ הגדרות</Text>
            <ScrollView>
              <Text style={styles.settingLabel}>שם התינוק</Text>
              <TextInput style={styles.input} value={tempBabyName} onChangeText={setTempBabyName} placeholder="שם התינוק" />
              <Text style={styles.settingLabel}>מטרת שינה יומית (שעות)</Text>
              <TextInput style={styles.input} value={tempSleepGoal} onChangeText={setTempSleepGoal} keyboardType="numeric" placeholder="15" />
              <Text style={styles.settingLabel}>שעת איפוס יומי (0-23)</Text>
              <TextInput style={styles.input} value={tempResetHour} onChangeText={setTempResetHour} keyboardType="numeric" placeholder="20" />
              <Text style={styles.sectionTitle}>איפוס נתונים</Text>
              <TouchableOpacity onPress={resetSleep} style={styles.resetBtnView}><Text style={styles.resetBtnText}>איפוס נתוני שינה בלבד</Text></TouchableOpacity>
              <TouchableOpacity onPress={resetHistoryAndEvents} style={[styles.resetBtnView, styles.resetAllBtnView]}><Text style={styles.resetBtnText}>איפוס יומן והיסטוריה</Text></TouchableOpacity>
              <TouchableOpacity onPress={resetAll} style={[styles.resetBtnView, styles.resetAllBtnView]}><Text style={styles.resetBtnText}>איפוס כל הנתונים</Text></TouchableOpacity>
              <TouchableOpacity onPress={saveSettings} style={styles.saveBtnView}><Text style={styles.saveBtnText}>שמור הגדרות ✓</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setShowSettings(false)} style={styles.cancelBtnView}><Text style={styles.cancelBtnText}>ביטול</Text></TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal visible={showManualAdd} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>➕ הוספת שינה ידנית</Text>
            <Text style={styles.settingLabel}>תאריך (לדוגמה 14.04.2026):</Text>
            <TextInput style={styles.input} value={manualDate} onChangeText={setManualDate} placeholder="DD.MM.YYYY" maxLength={10} />
            <Text style={styles.settingLabel}>שעת הירדמות (לדוגמה 13:00):</Text>
            <TextInput style={styles.input} value={manualStartTime} onChangeText={setManualStartTime} placeholder="HH:MM" maxLength={5} />
            <Text style={styles.settingLabel}>שעת יקיצה (לדוגמה 14:30):</Text>
            <TextInput style={styles.input} value={manualEndTime} onChangeText={setManualEndTime} placeholder="HH:MM" maxLength={5} />
            <TouchableOpacity onPress={addManualSleepSession} style={styles.saveBtnView}>
              <Text style={styles.saveBtnText}>הוסף ליומן ✓</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setShowManualAdd(false); setManualStartTime(''); setManualEndTime(''); setManualDate(''); }} style={styles.cancelBtnView}>
              <Text style={styles.cancelBtnText}>ביטול</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <Modal visible={showEditEvent} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>✏️ עריכת שעת אירוע</Text>
            <Text style={styles.settingLabel}>שעה (לדוגמה 14:30):</Text>
            <TextInput style={styles.input} value={editEventTime} onChangeText={setEditEventTime} placeholder="HH:MM" maxLength={5} />
            <TouchableOpacity onPress={confirmEditEvent} style={styles.saveBtnView}>
              <Text style={styles.saveBtnText}>שמור ✓</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowEditEvent(false)} style={styles.cancelBtnView}>
              <Text style={styles.cancelBtnText}>ביטול</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <Modal visible={showEditStart} animationType="fade" transparent>
  <View style={styles.modalOverlay}>
    <View style={styles.modalBox}>
      <Text style={styles.modalTitle}>✏️ עריכת שעת הירדמות</Text>
      <Text style={styles.settingLabel}>שעת הירדמות (לדוגמה 14:30):</Text>
      <TextInput style={styles.input} value={editStartTime} onChangeText={setEditStartTime} placeholder="HH:MM" maxLength={5} />
      <TouchableOpacity onPress={confirmEditStartTime} style={styles.saveBtnView}>
        <Text style={styles.saveBtnText}>שמור ✓</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setShowEditStart(false)} style={styles.cancelBtnView}>
        <Text style={styles.cancelBtnText}>ביטול</Text>
      </TouchableOpacity>
    </View>
  </View>
</Modal>
    </>
  );

  const renderMain = () => (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerButtons}>
          <TouchableOpacity onPress={shareDaySummary} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>📤</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => {
            const today = new Date();
            const dd = String(today.getDate()).padStart(2, '0');
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            setManualDate(`${dd}.${mm}.${today.getFullYear()}`);
            setShowManualAdd(true);
          }} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>✍️</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowEvents(true)} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>🕐</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowHistory(true)} style={styles.calendarBtn}>
            <Text style={styles.calendarMonth}>{['ינו','פבר','מרץ','אפר','מאי','יוני','יולי','אוג','ספט','אוק','נוב','דצמ'][new Date().getMonth()]}</Text>
            <Text style={styles.calendarDay}>{new Date().getDate()}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowSettings(true)} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.titleBubble}>
        <Text style={styles.titleBubbleText}>לוח השינה של {babyName} שלי 👶</Text>
      </View>

      {isOffline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>⚠️ אין חיבור לענן — שמור מקומית</Text>
        </View>
      )}

      <View style={styles.statusContainer}>
        <Text style={styles.label}>{isSleeping ? 'ישן עכשיו:' : 'חלון ערות:'}</Text>
        <TouchableOpacity onPress={isSleeping ? editActiveStartTime : undefined}>
          <Text style={[styles.mainTimer, isSleeping && { textDecorationLine: 'underline' }]}>
            {isSleeping ? formatTime(displaySleepTime) : formatTime(displayWakeTime)}
          </Text>
        </TouchableOpacity>
        {!isSleeping && lastSleepDuration > 0 && (
          <View style={styles.lastSleepCard}>
            <Text style={styles.lastSleepLabel}>😴 שינה קודמת</Text>
            <Text style={styles.lastSleepTime}>{formatTime(lastSleepDuration)}</Text>
          </View>
        )}
        {isSleeping && <Text style={{color: 'rgba(255,255,255,0.5)', fontSize: 12}}>לחץ על השעון לעריכת שעת התחלה</Text>}
      </View>

      <View style={styles.ringContainer}>
        <Svg width={RING_SIZE} height={RING_SIZE} style={styles.svg}>
          <Circle cx={RING_SIZE/2} cy={RING_SIZE/2} r={RADIUS} stroke="rgba(255,255,255,0.3)" strokeWidth={STROKE_WIDTH} fill="transparent" />
          <Circle cx={RING_SIZE/2} cy={RING_SIZE/2} r={RADIUS} stroke={ringColor} strokeWidth={STROKE_WIDTH} fill="transparent" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={strokeDashoffset} strokeLinecap="round" rotation="-90" origin={`${RING_SIZE/2}, ${RING_SIZE/2}`} />
        </Svg>
        <Animated.View style={pulseStyle}>
          <TouchableOpacity onPress={handleSleepPress} style={[styles.mainButton, isSleeping ? styles.wakeButton : styles.sleepButton]}>
            <Animated.View style={[sleepAnimStyle, { alignItems: 'center' }]}>
              <Text style={styles.mainButtonText}>{isSleeping ? 'התעורר!' : 'נרדם'}</Text>
              <Text style={styles.sleepProgressText}>{formatTime(displayTotalSleep)} / {sleepGoalHours}:00:00</Text>
            </Animated.View>
          </TouchableOpacity>
        </Animated.View>
      </View>


      {renderModals()}
    </SafeAreaView>
  );

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.webContainer, { backgroundColor: bgColor }]}>
        {renderMain()}
      </View>
    );
  }

  return (
    <ImageBackground
      source={isSleeping ? require('./assets/sleeping.jpg') : require('./assets/awake.jpg')}
      style={styles.background} resizeMode="cover"
    >
      <View style={styles.overlay} />
      {renderMain()}
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1 },
  webContainer: { flex: 1, minHeight: '100vh' as any },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  container: { flex: 1, alignItems: 'center', paddingTop: 20 },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a3a4e' },
  loadingText: { fontSize: 24, color: 'white' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', width: '90%', marginBottom: 16, marginTop: 20 },
  headerButtons: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  headerBtn: { padding: 4 },
  headerBtnText: { fontSize: 26 },
  calendarBtn: { backgroundColor: 'white', borderRadius: 8, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  calendarMonth: { backgroundColor: '#e74c3c', color: 'white', fontSize: 9, fontWeight: 'bold', width: '100%', textAlign: 'center' },
  calendarDay: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  titleBubble: { backgroundColor: 'rgba(99,179,237,0.25)', borderWidth: 2, borderColor: '#63B3ED', borderRadius: 50, paddingHorizontal: 32, paddingVertical: 10, marginBottom: 10 },
  titleBubbleText: { fontSize: 20, fontWeight: 'bold', color: '#BEE3F8', letterSpacing: 2, textAlign: 'center' },
  statusContainer: { alignItems: 'center', marginBottom: 16, marginTop: 10 },
  label: { fontSize: 18, color: 'rgba(255,255,255,0.9)', marginBottom: 6, marginTop: 10 },
  mainTimer: { fontSize: 56, fontWeight: 'bold', color: 'white' },
  subText: { fontSize: 14, color: 'rgba(255,255,255,0.7)', marginTop: 6 },
  ringContainer: { width: 220, height: 220, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  svg: { position: 'absolute' },
  mainButton: { width: 180, height: 180, borderRadius: 90, justifyContent: 'center', alignItems: 'center', elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 6 },
  sleepButton: { backgroundColor: 'rgba(52,152,219,0.9)' },
  wakeButton: { backgroundColor: 'rgba(241,196,15,0.9)' },
  mainButtonText: { fontSize: 28, fontWeight: 'bold', color: 'white', textAlign: 'center' },
  sleepProgressText: { fontSize: 11, color: 'white', marginTop: 6, opacity: 0.9, textAlign: 'center' },
  playContainer: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.2)', padding: 20, borderRadius: 20, width: '85%' },
  playHeader: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', alignItems: 'center' },
  goalText: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  playTimer: { fontSize: 38, fontWeight: 'bold', color: 'white', marginVertical: 12 },
  playButton: { paddingHorizontal: 30, paddingVertical: 15, borderRadius: 25, elevation: 4 },
  startPlayButton: { backgroundColor: '#2ecc71' },
  stopPlayButton: { backgroundColor: '#e74c3c' },
  playButtonText: { fontSize: 18, color: 'white', fontWeight: 'bold', textAlign: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  modalBox: { backgroundColor: 'white', borderRadius: 20, padding: 24, width: '88%', maxHeight: '85%' },
  modalTitle: { fontSize: 22, fontWeight: 'bold', color: '#333', marginBottom: 20, textAlign: 'center' },
  statsModalContent: { paddingVertical: 20, paddingHorizontal: 16, alignItems: 'center', width: '100%' },
  statsBox: { backgroundColor: '#0f0f23', borderRadius: 24, padding: 20, width: Math.min(SCREEN_WIDTH - 32, 400) },
  statsTitle: { fontSize: 20, fontWeight: 'bold', color: 'white', textAlign: 'center', marginBottom: 20 },
  statsCards: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  statCard: { backgroundColor: '#1a1a3e', borderRadius: 16, padding: 14, alignItems: 'center', flex: 1, marginHorizontal: 4 },
  statCardNum: { fontSize: 22, fontWeight: 'bold', color: '#3498DB', marginBottom: 4 },
  statCardLabel: { fontSize: 11, color: 'rgba(255,255,255,0.6)', textAlign: 'center', lineHeight: 16 },
  chartTitle: { fontSize: 14, fontWeight: 'bold', color: 'rgba(255,255,255,0.7)', marginBottom: 8, marginTop: 8 },
  chartLegend: { flexDirection: 'row', gap: 16, marginBottom: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, color: 'rgba(255,255,255,0.6)' },
  emptyHistoryDark: { fontSize: 13, color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginVertical: 16 },
  historyRow: { backgroundColor: '#1a1a3e', borderRadius: 14, padding: 14, marginBottom: 10 },
  historyDate: { fontSize: 13, fontWeight: 'bold', color: '#63B3ED', marginBottom: 8 },
  historyStats: { flexDirection: 'row', justifyContent: 'space-around' },
  historyStat: { alignItems: 'center' },
  historyStatNum: { fontSize: 16, fontWeight: 'bold', color: 'white' },
  historyStatLabel: { fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 2 },
  cancelBtnDarkView: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 16 },
  cancelBtnDarkText: { color: 'rgba(255,255,255,0.7)', fontSize: 15 },
  eventRow: { backgroundColor: '#f9f9f9', borderRadius: 10, padding: 12, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eventType: { fontSize: 15, fontWeight: 'bold', color: '#333', flex: 1 },
  eventTime: { fontSize: 18, fontWeight: 'bold', color: '#333', marginHorizontal: 8 },
  eventDate: { fontSize: 12, color: '#999' },
  settingLabel: { fontSize: 14, color: '#666', marginBottom: 6, marginTop: 12 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12, fontSize: 16, color: '#333', marginBottom: 4 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: '#333', marginTop: 20, marginBottom: 10 },
  resetBtnView: { backgroundColor: '#fff0f0', borderWidth: 1, borderColor: '#ffcccc', borderRadius: 10, padding: 14, marginBottom: 8, alignItems: 'center' },
  resetAllBtnView: { backgroundColor: '#ffe0e0', borderColor: '#ffaaaa' },
  resetBtnText: { color: '#e74c3c', fontWeight: 'bold', fontSize: 15 },
  saveBtnView: { backgroundColor: '#3498DB', borderRadius: 10, padding: 16, alignItems: 'center', marginTop: 16, marginBottom: 8 },
  saveBtnText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  cancelBtnView: { backgroundColor: '#f5f5f5', borderRadius: 10, padding: 14, alignItems: 'center', marginBottom: 8 },
  cancelBtnText: { color: '#666', fontSize: 15 },
  emptyHistory: { fontSize: 15, color: '#999', textAlign: 'center', marginVertical: 20, lineHeight: 24 },
  offlineBanner: { backgroundColor: 'rgba(231,76,60,0.85)', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6, marginBottom: 8 },
  offlineText: { color: 'white', fontSize: 13, fontWeight: 'bold' },
  lastSleepCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8, marginTop: 8 },
  lastSleepLabel: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  lastSleepTime: { fontSize: 18, fontWeight: 'bold', color: 'white' },
  eventActionBtn: { padding: 6, marginLeft: 2 },
});
