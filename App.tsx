
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage } from '@google/genai';
import { WorkspaceMetrics, ConnectionStatus, ProAnalysis } from './types';
import CameraPreview from './components/CameraPreview';
import ProInsightCard from './components/ProInsightCard';
import GlobalStatusBar from './components/GlobalStatusBar';
import Dashboard from './components/Dashboard';
import SessionLiveSummary from './components/SessionLiveSummary';
import { encode, decode } from './utils/audio-utils';

const FRAME_RATE = 2.0; 
const PRO_SNAPSHOT_INTERVAL = 10000; 
const NOTIFICATION_COOLDOWN = 30000; // 30 seconds

const reportErgonomicsFunction: FunctionDeclaration = {
  name: 'reportErgonomics',
  parameters: {
    type: Type.OBJECT,
    description: 'Updates current ergonomic and attention metrics.',
    properties: {
      posture: { type: Type.STRING, enum: ['Good', 'Slouching', 'Forward Head', 'Unknown'] },
      distance: { type: Type.NUMBER },
      blinksPerMinute: { type: Type.NUMBER },
      isFocused: { type: Type.BOOLEAN },
      isTired: { type: Type.BOOLEAN },
      feedback: { type: Type.STRING },
    },
    required: ['posture', 'distance', 'blinksPerMinute', 'isFocused', 'isTired', 'feedback'],
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [metrics, setMetrics] = useState<WorkspaceMetrics>({
    posture: 'Unknown',
    distance: 0,
    blinksPerMinute: 0,
    isFocused: true,
    isTired: false,
    feedback: 'Initializing Tenjin Vision Engine...',
    timestamp: Date.now(),
    currentAuditScore: 0,
    sessionAvgScore: 0
  });
  
  const [proInsight, setProInsight] = useState<ProAnalysis | null>(null);
  const [isAnalyzingPro, setIsAnalyzingPro] = useState(false);
  const [wellnessHistory, setWellnessHistory] = useState<ProAnalysis[]>([]);
  const [history, setHistory] = useState<WorkspaceMetrics[]>([]);
  const [activeToast, setActiveToast] = useState<{title: string, message: string} | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const lastNotificationTimeRef = useRef<number>(0);
  
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const triggerAlertSound = useCallback(() => {
    if (outputAudioContextRef.current) {
      const ctx = outputAudioContextRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); 
      osc.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.1); 
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    }
  }, []);

  const triggerNotification = useCallback((title: string, message: string) => {
    const now = Date.now();
    if (now - lastNotificationTimeRef.current < NOTIFICATION_COOLDOWN) return;
    
    lastNotificationTimeRef.current = now;
    if (Notification.permission === 'granted') {
      new Notification(title, { body: message });
    }
    
    setActiveToast({ title, message });
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setActiveToast(null), 7000);
    
    triggerAlertSound();
  }, [triggerAlertSound]);

  const calculateAuditScore = (audit: ProAnalysis): number => {
    let score = 0;
    const b = audit.blinking.status.toLowerCase();
    
    if (audit.neckAngle.status === 'Optimal') score += 25; 
    else if (audit.neckAngle.status === 'Strained') score += 10;

    if (audit.distance.status === 'Perfect') score += 25; 
    else if (audit.distance.status === 'Close') score += 10;

    if (b === 'normal') score += 25; 
    else if (b === 'slow') score += 10;
    else if (b.includes('heavy') || b.includes('droopy')) score += 0; 

    if (audit.focus.status === 'Focused') score += 25; 
    else if (audit.focus.status === 'Distracted') score += 10;
    
    return score;
  };

  useEffect(() => {
    if (!proInsight || status !== ConnectionStatus.CONNECTED) return;

    let issues: string[] = [];
    const { neckAngle, distance, blinking, focus } = proInsight;
    const bStatus = blinking.status.toLowerCase();

    if (neckAngle.status !== 'Optimal') issues.push(`Neck: ${neckAngle.status}`);
    if (distance.status !== 'Perfect') issues.push(`Distance: ${distance.status}`);
    if (bStatus !== 'normal') issues.push(`Ocular: ${blinking.status}`);
    if (focus.status !== 'Focused') issues.push(`Focus: ${focus.status}`);

    if (issues.length > 0) {
      triggerNotification("Tenjin Alert", `Workspace protocol compromised: ${issues.join(', ')}.`);
    }

    const auditScore = calculateAuditScore(proInsight);
    setWellnessHistory(prev => {
      const newWellness = [...prev, proInsight];
      const avgScore = Math.round(newWellness.reduce((acc, curr) => acc + calculateAuditScore(curr), 0) / newWellness.length);
      setMetrics(prevM => ({ ...prevM, currentAuditScore: auditScore, sessionAvgScore: avgScore }));
      return newWellness;
    });

  }, [proInsight, triggerNotification, status]);

  const performProAnalysis = async (blob: Blob) => {
    if (isAnalyzingPro) return;
    setIsAnalyzingPro(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const base64Data = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(blob);
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: {
          parts: [
            { inlineData: { data: base64Data, mimeType: 'image/jpeg' } },
            { text: "Precision Wellness Audit: 1. Neck (Optimal/Strained/Poor), 2. Distance (Perfect/Close/Too Close), 3. Blinking (Normal/Slow/Dry Eyes/Heavy/Droopy), 4. Focus (Focused/Distracted/Tilted Away). POSTURE LENIENCY: Humans aren't static. If the user's posture is reasonably close to vertical and not clearly slouching or craning forward, mark as 'Optimal'. Only penalize obvious strain. Return JSON." }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              neckAngle: { type: Type.OBJECT, properties: { status: { type: Type.STRING }, message: { type: Type.STRING } } },
              distance: { type: Type.OBJECT, properties: { status: { type: Type.STRING }, message: { type: Type.STRING } } },
              blinking: { type: Type.OBJECT, properties: { status: { type: Type.STRING }, message: { type: Type.STRING } } },
              focus: { type: Type.OBJECT, properties: { status: { type: Type.STRING }, message: { type: Type.STRING } } },
              summary: { type: Type.STRING }
            },
            required: ['neckAngle', 'distance', 'blinking', 'focus', 'summary']
          }
        }
      });
      
      const resText = response.text;
      if (resText) setProInsight(JSON.parse(resText));
    } catch (e: any) { console.warn("Analysis failed:", e); } finally { setIsAnalyzingPro(false); }
  };

  const openReportInNewWindow = (history: ProAnalysis[], totalMinutes: number) => {
    const avgScore = Math.round(history.reduce((acc, curr) => acc + calculateAuditScore(curr), 0) / history.length);
    const getS = (arr: string[], top: string, mid: string) => {
      const s = arr.reduce((a, v) => v.toLowerCase() === top.toLowerCase() ? a + 10 : (v.toLowerCase() === mid.toLowerCase() ? a + 5 : a), 0);
      return parseFloat((s / arr.length).toFixed(1));
    };

    const nS = getS(history.map(a => a.neckAngle.status), 'Optimal', 'Strained');
    const dS = getS(history.map(a => a.distance.status), 'Perfect', 'Close');
    const bS = getS(history.map(a => a.blinking.status), 'Normal', 'Slow');
    const fS = getS(history.map(a => a.focus.status), 'Focused', 'Distracted');

    const categories = [
      { 
        score: nS, label: "Postural Integrity", rec: "Raise display to eye level.", 
        why: ["Forward head tilt exerts up to 60 lbs of pressure on the spine.", "Slouching reduces oxygen intake and causes muscle fatigue."], 
        praise: "Excellent stability. You have maintained a strong, neutral spine throughout the session. This is a vital foundation for long-term health.", 
        critique: "Observe if your shoulders round during high-intensity moments." 
      },
      { 
        score: dS, label: "Optical Distance", rec: "Maintain 50cm-70cm spacing.", 
        why: ["Close viewing triggers ciliary muscle spasm.", "Digital myopia is often accelerated by screen proximity."], 
        praise: "Your spacing protocol is precise. By keeping a healthy distance, you're significantly reducing eye strain and myopia risk.", 
        critique: "Check that you aren't leaning in to read small text." 
      },
      { 
        score: bS, label: "Ocular Health", rec: "Intentional blinking breaks.", 
        why: ["Heavy/Droopy eyelids are high fatigue markers.", "Screen staring reduces blink rate by 60%, drying the cornea."], 
        praise: "Exceptional ocular awareness. Your frequent blinking and clear gaze indicate high hydration levels and healthy eyes.", 
        critique: "Consider the 20-20-20 rule to maintain this high score." 
      },
      { 
        score: fS, label: "Cognitive Depth", rec: "Minimize gaze shifts.", 
        why: ["Lateral gazing breaks flow and triggers attention residue.", "Context switching is highly metabolic for the brain."], 
        praise: "Elite mental discipline. You successfully entered a 'Deep Work' state with minimal peripheral distractions.", 
        critique: "Periodic 1-minute mental resets can prolong this peak state." 
      }
    ];

    const reportHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Tenjin's Vision: Protocol Audit</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
        <style>
          body { background: #020202; color: #fff; font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 2.5rem; }
          .container-box { background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 3rem; width: 100%; max-width: 800px; padding: 4rem; box-shadow: 0 60px 180px rgba(0,0,0,1); border: 2px solid #111; }
          .praise-section { background: #10b98108; border-left: 5px solid #10b981; padding: 2rem; border-radius: 0 1.5rem 1.5rem 0; margin-bottom: 2rem; }
          .warning-section { background: #f43f5e08; border-left: 5px solid #f43f5e; padding: 2rem; border-radius: 0 1.5rem 1.5rem 0; margin-bottom: 2rem; }
        </style>
      </head>
      <body>
        <div class="container-box space-y-12 animate-in fade-in slide-in-from-bottom-10 duration-1000">
          <header class="flex justify-between items-end border-b border-white/5 pb-12">
            <div>
              <p class="text-indigo-400 font-black uppercase tracking-[0.5em] text-[11px] mb-4">Workspace Synthesis Report</p>
              <h1 class="text-5xl font-black italic tracking-tighter uppercase text-white">Tenjin's session Audit</h1>
              <p class="text-gray-500 text-sm mt-4 font-bold uppercase tracking-widest italic">Monitoring: ${totalMinutes}m</p>
            </div>
            <div class="text-right">
              <span class="text-8xl font-black ${avgScore >= 80 ? 'text-emerald-500' : (avgScore >= 60 ? 'text-amber-500' : 'text-rose-500')} tracking-tighter">${avgScore}%</span>
              <p class="text-[12px] font-black text-gray-700 uppercase tracking-widest mt-2">Workspace index</p>
            </div>
          </header>

          <section class="space-y-10">
            <h3 class="text-[12px] font-black text-indigo-500 uppercase tracking-[0.6em] mb-8">Clinical Category Breakdown</h3>
            <div class="grid grid-cols-1 gap-10">
              ${categories.map(c => `
                <div class="p-10 bg-white/[0.01] border border-white/5 rounded-[2.5rem] transition-all hover:bg-white/[0.02]">
                  <div class="flex justify-between items-center mb-8">
                    <h4 class="text-xl font-black uppercase tracking-tight text-white">${c.label}</h4>
                    <span class="text-3xl font-black ${c.score >= 8 ? 'text-emerald-500' : (c.score >= 6 ? 'text-amber-500' : 'text-rose-500')} italic">${c.score}<span class="text-sm opacity-30 not-italic">/10</span></span>
                  </div>
                  
                  ${c.score >= 8 ? `
                    <div class="praise-section">
                       <p class="text-emerald-400 text-xs font-black uppercase mb-3 tracking-[0.3em]">Tenjin's Praise</p>
                       <p class="text-base text-gray-200 leading-relaxed font-medium italic">"${c.praise}"</p>
                       <div class="mt-6 pt-6 border-t border-emerald-500/10">
                          <p class="text-[10px] text-emerald-500/50 font-black uppercase tracking-widest mb-1 italic">Minor Optimization Protocol</p>
                          <p class="text-[13px] text-emerald-300/40">${c.critique}</p>
                       </div>
                    </div>
                  ` : `
                    <div class="warning-section">
                       <p class="text-rose-400 text-xs font-black uppercase mb-3 tracking-[0.3em]">Critical Protocol Drift</p>
                       <p class="text-base text-rose-200 font-black mb-4 italic">Action Required: ${c.rec}</p>
                       <ul class="space-y-2">
                         ${c.why.map(w => `<li class="text-[13px] text-rose-300/50 font-medium leading-relaxed">• ${w}</li>`).join('')}
                       </ul>
                    </div>
                  `}
                </div>
              `).join('')}
            </div>
          </section>

          <footer class="pt-12 border-t border-white/5 flex justify-between items-center">
            <p class="text-[11px] font-black text-gray-800 uppercase tracking-[0.6em]">Vision AI Engine v5.5 // Protocol 7-Beta</p>
            <div class="flex gap-2">
               ${[1,2,3].map(() => `<div class="w-1 h-1 bg-white/5 rounded-full"></div>`).join('')}
            </div>
          </footer>
        </div>
      </body>
      </html>
    `;
    const blob = new Blob([reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  };

  const stopSession = useCallback(() => {
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    if (snapshotTimerRef.current) window.clearInterval(snapshotTimerRef.current);
    if (sessionPromiseRef.current) sessionPromiseRef.current.then(s => s.close()).catch(() => {});
    sessionPromiseRef.current = null;
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    
    const totalMinutes = Math.max(1, Math.round((Date.now() - (history[0]?.timestamp || Date.now())) / 60000));
    if (wellnessHistory.length > 0) openReportInNewWindow(wellnessHistory, totalMinutes);
    
    setStatus(ConnectionStatus.DISCONNECTED);
    setMetrics({ posture: 'Unknown', distance: 0, blinksPerMinute: 0, isFocused: true, isTired: false, feedback: 'Session archived.', timestamp: Date.now(), currentAuditScore: 0, sessionAvgScore: 0 });
    setProInsight(null); setWellnessHistory([]); setHistory([]); setActiveToast(null);
  }, [history, wellnessHistory]);

  const startSession = async () => {
    try {
      if (window.aistudio && !(await window.aistudio.hasSelectedApiKey())) await window.aistudio.openSelectKey();
      setHistory([]); setWellnessHistory([]); setStatus(ConnectionStatus.CONNECTING);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
      if (videoRef.current) videoRef.current.srcObject = stream;
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [reportErgonomicsFunction] }],
          systemInstruction: `Tenjin's Vision Monitor. Monitor Workspace Ergonomics. Be reasonably lenient with posture; mark as Optimal if 'close enough' to correct. Identify heavy eyelids as fatigue.`,
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const processor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } }));
            };
            source.connect(processor); processor.connect(inputAudioContextRef.current!.destination);
            frameIntervalRef.current = window.setInterval(() => {
              if (canvasRef.current && videoRef.current) {
                const ctx = canvasRef.current.getContext('2d');
                if (ctx) { ctx.drawImage(videoRef.current, 0, 0, 1280, 720); const base64 = canvasRef.current.toDataURL('image/jpeg', 0.6).split(',')[1]; sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } })); }
              }
            }, 1000 / FRAME_RATE);
            snapshotTimerRef.current = window.setInterval(() => { if (canvasRef.current) canvasRef.current.toBlob(b => b && performProAnalysis(b), 'image/jpeg', 0.8); }, PRO_SNAPSHOT_INTERVAL);
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.toolCall) {
              for (const fc of m.toolCall.functionCalls) {
                if (fc.name === 'reportErgonomics') {
                  const args = fc.args as any;
                  setHistory(prev => [...prev, { ...args, timestamp: Date.now() }]);
                  setMetrics(p => ({ ...p, ...args, timestamp: Date.now() }));
                  sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } }));
                }
              }
            }
          },
          onclose: () => setStatus(ConnectionStatus.DISCONNECTED),
        },
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (e) { setStatus(ConnectionStatus.ERROR); }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-[#eee] font-sans relative">
      <div className={`fixed top-12 left-1/2 -translate-x-1/2 z-[250] w-full max-w-lg px-6 transition-all duration-700 ${activeToast ? 'translate-y-0 opacity-100 scale-100' : '-translate-y-40 opacity-0 scale-95 pointer-events-none'}`}>
        <div className="bg-rose-600 text-white rounded-[1.5rem] p-6 shadow-2xl flex items-start gap-5 border border-rose-400/30 backdrop-blur-md">
          <div className="bg-white/20 p-3 rounded-2xl text-2xl flex-shrink-0">⚠️</div>
          <div className="flex-1">
            <h4 className="text-[12px] font-black uppercase tracking-[0.3em] mb-1">Tenjin Warning</h4>
            <p className="text-[14px] font-semibold leading-relaxed opacity-95">{activeToast?.message}</p>
          </div>
        </div>
      </div>
      <GlobalStatusBar proInsight={proInsight} metrics={metrics} isActive={status === ConnectionStatus.CONNECTED} onTogglePiP={() => {}} />
      <main className="pt-24 pb-12 px-4 md:px-8 max-w-full xl:max-w-[1900px] mx-auto flex flex-col min-h-screen">
        <div className="flex flex-col gap-8 flex-grow">
          {status === ConnectionStatus.CONNECTED && <SessionLiveSummary history={history} wellnessHistory={wellnessHistory} metrics={metrics} />}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-stretch flex-grow">
            <div className="xl:col-span-8 flex flex-col gap-8">
              <CameraPreview videoRef={videoRef} canvasRef={canvasRef} isActive={status === ConnectionStatus.CONNECTED} />
              <Dashboard metrics={metrics} isActive={status === ConnectionStatus.CONNECTED} />
            </div>
            <div className="xl:col-span-4 flex flex-col gap-8">
              <ProInsightCard insight={proInsight} isAnalyzing={isAnalyzingPro} />
              <div className="bg-[#0c0c0c] border border-white/5 rounded-[3rem] p-10 flex flex-col items-center gap-8 shadow-2xl mt-auto">
                {status !== ConnectionStatus.CONNECTED ? (
                  <div className="w-full space-y-6">
                    <h3 className="text-xl font-black text-center text-white uppercase tracking-tighter italic">Vision Initialization</h3>
                    <button onClick={startSession} className="w-full py-6 bg-indigo-600 rounded-[1.5rem] text-xl font-black uppercase italic tracking-tighter hover:bg-indigo-500 transition-all shadow-[0_0_50px_-10px_rgba(79,70,229,0.7)] hover:scale-[1.02]">Enable Tenjin Vision</button>
                  </div>
                ) : (
                  <button onClick={stopSession} className="w-full py-6 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-[1.5rem] text-xl font-black uppercase italic tracking-tighter hover:bg-rose-500/20 transition-all hover:scale-[0.98]">Terminate Protocol</button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
