import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, SafeAreaView, Platform,
  ImageBackground, Modal, ScrollView, TextInput, Dimensions, TouchableOpacity
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Rect, Line, Text as SvgText, G } from 'react-native-svg';
import Animated, {
  useSharedValue, useAnimatedStyle, withSequence, withTiming
} from 'react-native-reanimated';
import { db } from './firebase';
import { doc, setDoc } from 'firebase/firestore';

const BABY_ID = 'maor';
const STORAGE_KEY = 'maor_baby_state';
const HISTORY_KEY = 'maor_baby_history_v2';
const EVENTS_KEY = 'maor_baby_events';
const SCREEN_WIDTH = Dimensions.get('window').width;

interface SavedState {
  isSleeping: boolean;
  isPlaying: boolean;
  sleepStartTime: number | null;
  wakeStartTime: number | null;
  playStartTime: number | null;
  lastSleepDuration: number;
  totalPlayToday: number;
  totalSleepToday: number;
  sleepCountToday: number;
  lastDate: string;
  babyName: string;
  sleepGoalHours: number;
  playGoalHours: number;
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
    const { Alert } = require('react-native');
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
  const isPlayingRef = useRef(false);
  const sleepStartTimeRef = useRef<number | null>(null);
  const wakeStartTimeRef = useRef<number | null>(null);
  const playStartTimeRef = useRef<number | null>(null);
  const totalSleepTodayRef = useRef(0);
  const totalPlayTodayRef = useRef(0);
  const sleepCountTodayRef = useRef(0);
  const currentDateRef = useRef('');
  const resetHourRef = useRef(20);
  const historyRef = useRef<DayHistory[]>([]);

  const [isSleeping, setIsSleeping] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [lastSleepDuration, setLastSleepDuration] = useState(0);
  const [displaySleepTime, setDisplaySleepTime] = useState(0);
  const [displayWakeTime, setDisplayWakeTime] = useState(0);
  const [displayPlayTime, setDisplayPlayTime] = useState(0);
  const [displayTotalSleep, setDisplayTotalSleep] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [babyName, setBabyName] = useState('מאיר');
  const [sleepGoalHours, setSleepGoalHours] = useState(15);
  const [playGoalHours, setPlayGoalHours] = useState(3);
  const [resetHour, setResetHour] = useState(20);
  const [showSettings, setShowSettings] = useState(false);
  const [tempBabyName, setTempBabyName] = useState('מאיר');
  const [tempSleepGoal, setTempSleepGoal] = useState('15');
  const [tempPlayGoal, setTempPlayGoal] = useState('3');
  const [tempResetHour, setTempResetHour] = useState('20');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<DayHistory[]>([]);
  const [sleepEvents, setSleepEvents] = useState<SleepEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);

  const sleepScale = useSharedValue(1);
  const sleepAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: sleepScale.value }] }));
  const playScale = useSharedValue(1);
  const playAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: playScale.value }] }));

  const saveHistoryToStorage = async (newHistory: DayHistory[]) => {
    try { await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory)); } catch (e) { console.error(e); }
  };

  const backupToFirebase = async (h: DayHistory[]) => {
    try { await setDoc(doc(db, 'babies', BABY_ID), { lastBackup: new Date().toISOString(), history: h }); } catch (e) { console.error(e); }
  };

  const saveDayToHistory = (date: string, totalSleep: number, totalPlay: number, sleepCount: number) => {
    const current = historyRef.current;
    const existing = current.findIndex(d => d.date === date);
    let updated: DayHistory[];
    if (existing >= 0) {
      updated = [...current];
      updated[existing] = { date, totalSleep, totalPlay, sleepCount };
    } else {
      updated = [{ date, totalSleep, totalPlay, sleepCount }, ...current].slice(0, 7);
    }
    historyRef.current = updated;
    setHistory(updated);
    saveHistoryToStorage(updated);
    return updated;
  };

  const saveState = async (extraData?: Partial<SavedState>) => {
    const state: SavedState = {
      isSleeping: isSleepingRef.current,
      isPlaying: isPlayingRef.current,
      sleepStartTime: sleepStartTimeRef.current,
      wakeStartTime: wakeStartTimeRef.current,
      playStartTime: playStartTimeRef.current,
      lastSleepDuration: 0,
      totalPlayToday: totalPlayTodayRef.current,
      totalSleepToday: totalSleepTodayRef.current,
      sleepCountToday: sleepCountTodayRef.current,
      lastDate: getToday(resetHourRef.current),
      babyName,
      sleepGoalHours,
      playGoalHours,
      resetHour: resetHourRef.current,
      ...extraData,
    };
    try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.error(e); }
  };

  const applyState = (state: SavedState) => {
    const rh = state.resetHour ?? 20;
    const today = getToday(rh);
    const isNewDay = state.lastDate !== today;
    const totalSleep = isNewDay ? 0 : (state.totalSleepToday ?? 0);
    const totalPlay = isNewDay ? 0 : (state.totalPlayToday ?? 0);
    const sleepCount = isNewDay ? 0 : (state.sleepCountToday ?? 0);

    isSleepingRef.current = state.isSleeping;
    isPlayingRef.current = isNewDay ? false : state.isPlaying;
    sleepStartTimeRef.current = state.sleepStartTime;
    wakeStartTimeRef.current = state.wakeStartTime;
    playStartTimeRef.current = isNewDay ? null : state.playStartTime;
    totalSleepTodayRef.current = totalSleep;
    totalPlayTodayRef.current = totalPlay;
    sleepCountTodayRef.current = sleepCount;
    currentDateRef.current = today;
    resetHourRef.current = rh;

    setIsSleeping(state.isSleeping);
    setIsPlaying(isNewDay ? false : state.isPlaying);
    setLastSleepDuration(state.lastSleepDuration);
    setBabyName(state.babyName ?? 'מאיר');
    setSleepGoalHours(state.sleepGoalHours ?? 15);
    setPlayGoalHours(state.playGoalHours ?? 3);
    setResetHour(rh);
    setTempBabyName(state.babyName ?? 'מאיר');
    setTempSleepGoal(String(state.sleepGoalHours ?? 15));
    setTempPlayGoal(String(state.playGoalHours ?? 3));
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
    if (!isNewDay && state.isPlaying && state.playStartTime) {
      setDisplayPlayTime(totalPlay + Math.floor((now - state.playStartTime) / 1000));
    } else {
      setDisplayPlayTime(totalPlay);
    }
    if (isNewDay && state.totalSleepToday > 0) {
      saveDayToHistory(state.lastDate, state.totalSleepToday, state.totalPlayToday, state.sleepCountToday ?? 0);
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
        if (savedEvents) setSleepEvents(JSON.parse(savedEvents));
      } catch (e) { console.error(e); } finally { setIsLoaded(true); }
    };
    loadState();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const today = getToday(resetHourRef.current);
      if (today !== currentDateRef.current && currentDateRef.current !== '') {
        const updated = saveDayToHistory(currentDateRef.current, totalSleepTodayRef.current, totalPlayTodayRef.current, sleepCountTodayRef.current);
        backupToFirebase(updated);
        currentDateRef.current = today;
        totalSleepTodayRef.current = 0; totalPlayTodayRef.current = 0; sleepCountTodayRef.current = 0;
        isSleepingRef.current = false; isPlayingRef.current = false; playStartTimeRef.current = null;
        setIsSleeping(false); setIsPlaying(false); setDisplayTotalSleep(0); setDisplayPlayTime(0);
        return;
      }
      if (isSleepingRef.current && sleepStartTimeRef.current) {
        const currentSleep = Math.floor((now - sleepStartTimeRef.current) / 1000);
        setDisplaySleepTime(currentSleep);
        setDisplayTotalSleep(totalSleepTodayRef.current + currentSleep);
      }
      if (!isSleepingRef.current && wakeStartTimeRef.current) setDisplayWakeTime(Math.floor((now - wakeStartTimeRef.current) / 1000));
      if (isPlayingRef.current && playStartTimeRef.current) setDisplayPlayTime(totalPlayTodayRef.current + Math.floor((now - playStartTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const addSleepEvent = async (type: 'נרדם' | 'התעורר', duration?: string) => {
    const now = new Date();
    const event: SleepEvent = { type, time: formatExactTime(now), date: now.toLocaleDateString('he-IL'), duration: duration ?? null };
    setSleepEvents(prev => {
      const updated = [event, ...prev].slice(0, 50);
      AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  const toggleSleep = () => {
    const now = Date.now();
    if (isSleepingRef.current) {
      const sleptFor = sleepStartTimeRef.current ? Math.floor((now - sleepStartTimeRef.current) / 1000) : 0;
      const newTotalSleep = totalSleepTodayRef.current + sleptFor;
      isSleepingRef.current = false; isPlayingRef.current = false;
      sleepStartTimeRef.current = null; wakeStartTimeRef.current = now;
      playStartTimeRef.current = null; totalSleepTodayRef.current = newTotalSleep;
      setIsSleeping(false); setIsPlaying(false); setLastSleepDuration(sleptFor); setDisplayWakeTime(0);
      addSleepEvent('התעורר', formatTime(sleptFor));
      saveDayToHistory(currentDateRef.current, newTotalSleep, totalPlayTodayRef.current, sleepCountTodayRef.current);
      saveState();
    } else {
      const newCount = sleepCountTodayRef.current + 1;
      isSleepingRef.current = true; sleepStartTimeRef.current = now;
      isPlayingRef.current = false; playStartTimeRef.current = null; sleepCountTodayRef.current = newCount;
      setIsSleeping(true); setIsPlaying(false); setDisplaySleepTime(0);
      addSleepEvent('נרדם'); saveState();
    }
  };

  const togglePlay = () => {
    const now = Date.now();
    if (isPlayingRef.current) {
      const sessionTime = playStartTimeRef.current ? Math.floor((now - playStartTimeRef.current) / 1000) : 0;
      const newTotal = totalPlayTodayRef.current + sessionTime;
      totalPlayTodayRef.current = newTotal; playStartTimeRef.current = null; isPlayingRef.current = false;
      setIsPlaying(false); setDisplayPlayTime(newTotal);
    } else {
      playStartTimeRef.current = now; isPlayingRef.current = true; setIsPlaying(true);
    }
    saveState();
  };

  const handleSleepPress = () => {
    sleepScale.value = withSequence(withTiming(0.94, { duration: 80 }), withTiming(1, { duration: 80 }));
    toggleSleep();
  };

  const handlePlayPress = () => {
    playScale.value = withSequence(withTiming(0.94, { duration: 80 }), withTiming(1, { duration: 80 }));
    togglePlay();
  };

  const saveSettings = () => {
    const newSleepGoal = parseFloat(tempSleepGoal) || 15;
    const newPlayGoal = parseFloat(tempPlayGoal) || 3;
    const newResetHour = parseInt(tempResetHour) || 20;
    setBabyName(tempBabyName); setSleepGoalHours(newSleepGoal); setPlayGoalHours(newPlayGoal); setResetHour(newResetHour);
    resetHourRef.current = newResetHour;
    saveState({ babyName: tempBabyName, sleepGoalHours: newSleepGoal, playGoalHours: newPlayGoal, resetHour: newResetHour });
    setShowSettings(false);
  };

  const resetAll = () => webConfirm('איפוס כל הנתונים — האם אתה בטוח?', () => {
    isSleepingRef.current = false; isPlayingRef.current = false;
    sleepStartTimeRef.current = null; wakeStartTimeRef.current = null;
    playStartTimeRef.current = null; totalSleepTodayRef.current = 0;
    totalPlayTodayRef.current = 0; sleepCountTodayRef.current = 0;
    setIsSleeping(false); setIsPlaying(false); setLastSleepDuration(0);
    setDisplaySleepTime(0); setDisplayWakeTime(0); setDisplayPlayTime(0); setDisplayTotalSleep(0);
    saveState();
  });

  const resetSleep = () => webConfirm('איפוס נתוני שינה — האם אתה בטוח?', () => {
    isSleepingRef.current = false; sleepStartTimeRef.current = null;
    totalSleepTodayRef.current = 0; sleepCountTodayRef.current = 0;
    setIsSleeping(false); setLastSleepDuration(0); setDisplaySleepTime(0); setDisplayTotalSleep(0);
    saveState();
  });

  const resetPlay = () => webConfirm('איפוס נתוני פעילות — האם אתה בטוח?', () => {
    isPlayingRef.current = false; playStartTimeRef.current = null; totalPlayTodayRef.current = 0;
    setIsPlaying(false); setDisplayPlayTime(0); saveState();
  });

  const resetHistoryAndEvents = () => webConfirm('איפוס יומן והיסטוריה — האם אתה בטוח?', () => {
    historyRef.current = []; setHistory([]); setSleepEvents([]);
    AsyncStorage.removeItem(HISTORY_KEY); AsyncStorage.removeItem(EVENTS_KEY);
  });

  const avgSleepSeconds = history.length > 0 ? history.reduce((s, d) => s + d.totalSleep, 0) / history.length : 0;
  const avgSleepCount = history.length > 0 ? history.reduce((s, d) => s + d.sleepCount, 0) / history.length : 0;
  const sleepHoursArr = sleepEvents.filter(e => e.type === 'נרדם').map(e => parseInt(e.time.split(':')[0]));
  const mostCommonHour = sleepHoursArr.length > 0 ? sleepHoursArr.sort((a, b) => sleepHoursArr.filter(h => h === b).length - sleepHoursArr.filter(h => h === a).length)[0] : null;

  const SLEEP_GOAL_SECONDS = sleepGoalHours * 3600;
  const PLAY_GOAL_SECONDS = playGoalHours * 3600;
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
                    <Text style={styles.eventType}>{event.type === 'נרדם' ? '😴 נרדם' : `☀️ התעורר${event.duration ? ` — ${event.duration}` : ''}`}</Text>
                    <Text style={styles.eventTime}>{event.time}</Text>
                    <Text style={styles.eventDate}>{event.date}</Text>
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
              <Text style={styles.settingLabel}>מטרת פעילות יומית (שעות)</Text>
              <TextInput style={styles.input} value={tempPlayGoal} onChangeText={setTempPlayGoal} keyboardType="numeric" placeholder="3" />
              <Text style={styles.settingLabel}>שעת איפוס יומי (0-23)</Text>
              <TextInput style={styles.input} value={tempResetHour} onChangeText={setTempResetHour} keyboardType="numeric" placeholder="20" />
              <Text style={styles.sectionTitle}>איפוס נתונים</Text>
              <TouchableOpacity onPress={resetSleep} style={styles.resetBtnView}><Text style={styles.resetBtnText}>איפוס נתוני שינה בלבד</Text></TouchableOpacity>
              <TouchableOpacity onPress={resetPlay} style={styles.resetBtnView}><Text style={styles.resetBtnText}>איפוס נתוני פעילות בלבד</Text></TouchableOpacity>
              <TouchableOpacity onPress={resetHistoryAndEvents} style={[styles.resetBtnView, styles.resetAllBtnView]}><Text style={styles.resetBtnText}>איפוס יומן והיסטוריה</Text></TouchableOpacity>
              <TouchableOpacity onPress={resetAll} style={[styles.resetBtnView, styles.resetAllBtnView]}><Text style={styles.resetBtnText}>איפוס כל הנתונים</Text></TouchableOpacity>
              <TouchableOpacity onPress={saveSettings} style={styles.saveBtnView}><Text style={styles.saveBtnText}>שמור הגדרות ✓</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setShowSettings(false)} style={styles.cancelBtnView}><Text style={styles.cancelBtnText}>ביטול</Text></TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );

  const renderMain = () => (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerButtons}>
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
        <Text style={styles.titleBubbleText}>לוח השינה של מאיר שלי 👶</Text>
      </View>

      <View style={styles.statusContainer}>
        <Text style={styles.label}>{isSleeping ? 'ישן עכשיו:' : 'חלון ערות:'}</Text>
        <Text style={styles.mainTimer}>{isSleeping ? formatTime(displaySleepTime) : formatTime(displayWakeTime)}</Text>
        {!isSleeping && lastSleepDuration > 0 && <Text style={styles.subText}>ישן בפעם הקודמת: {formatTime(lastSleepDuration)}</Text>}
      </View>

      <View style={styles.ringContainer}>
        <Svg width={RING_SIZE} height={RING_SIZE} style={styles.svg}>
          <Circle cx={RING_SIZE/2} cy={RING_SIZE/2} r={RADIUS} stroke="rgba(255,255,255,0.3)" strokeWidth={STROKE_WIDTH} fill="transparent" />
          <Circle cx={RING_SIZE/2} cy={RING_SIZE/2} r={RADIUS} stroke={ringColor} strokeWidth={STROKE_WIDTH} fill="transparent" strokeDasharray={CIRCUMFERENCE} strokeDashoffset={strokeDashoffset} strokeLinecap="round" rotation="-90" origin={`${RING_SIZE/2}, ${RING_SIZE/2}`} />
        </Svg>
        <TouchableOpacity onPress={handleSleepPress} style={[styles.mainButton, isSleeping ? styles.wakeButton : styles.sleepButton]}>
          <Animated.View style={[sleepAnimStyle, { alignItems: 'center' }]}>
            <Text style={styles.mainButtonText}>{isSleeping ? 'התעורר!' : 'נרדם'}</Text>
            <Text style={styles.sleepProgressText}>{formatTime(displayTotalSleep)} / {sleepGoalHours}:00:00</Text>
          </Animated.View>
        </TouchableOpacity>
      </View>

      {!isSleeping && (
        <View style={styles.playContainer}>
          <View style={styles.playHeader}>
            <Text style={styles.label}>סה״כ פעילות היום:</Text>
            {playGoalHours > 0 && <Text style={styles.goalText}>מטרה: {playGoalHours} שעות</Text>}
          </View>
          <Text style={[styles.playTimer, displayPlayTime >= PLAY_GOAL_SECONDS && { color: '#2ecc71' }]}>{formatTime(displayPlayTime)}</Text>
          <TouchableOpacity onPress={handlePlayPress} style={[styles.playButton, isPlaying ? styles.stopPlayButton : styles.startPlayButton]}>
            <Animated.View style={playAnimStyle}>
              <Text style={styles.playButtonText}>{isPlaying ? 'הפסק פעילות' : 'התחל פעילות'}</Text>
            </Animated.View>
          </TouchableOpacity>
        </View>
      )}

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
});
