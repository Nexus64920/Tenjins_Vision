
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
  
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const triggerAlertSound = useCallback(() => {
    if (outputAudioContextRef.current) {
      const ctx = outputAudioContextRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.1); // D6
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    }
  }, []);

  const triggerNotification = useCallback((title: string, message: string) => {
    if (Notification.permission === 'granted') {
      new Notification(title, { body: message });
    }
    setActiveToast({ title, message });
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setActiveToast(null), 7000);
  }, []);

  const calculateAuditScore = (audit: ProAnalysis): number => {
    let score = 0;
    const b = audit.blinking.status.toLowerCase();
    if (audit.neckAngle.status === 'Optimal') score += 25; else if (audit.neckAngle.status === 'Strained') score += 10;
    if (audit.distance.status === 'Perfect') score += 25; else if (audit.distance.status === 'Close') score += 10;
    if (b === 'normal') score += 25; else if (b === 'slow') score += 10;
    if (audit.focus.status === 'Focused') score += 25; else if (audit.focus.status === 'Distracted') score += 10;
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
      triggerNotification("Tenjin's Vision Alert", `Anomalies: ${issues.join(', ')}. Optimize your setup for health.`);
      triggerAlertSound();
    }

    const auditScore = calculateAuditScore(proInsight);
    setWellnessHistory(prev => {
      const newWellness = [...prev, proInsight];
      const avgScore = Math.round(newWellness.reduce((acc, curr) => acc + calculateAuditScore(curr), 0) / newWellness.length);
      setMetrics(prevM => ({ ...prevM, currentAuditScore: auditScore, sessionAvgScore: avgScore }));
      return newWellness;
    });

  }, [proInsight, triggerNotification, triggerAlertSound, status]);

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
            { text: "Precision Wellness Audit: 1. Neck (Optimal/Strained/Poor), 2. Distance (Perfect/Close/Too Close), 3. Blinking (Normal/Slow/Dry Eyes/Heavy/Droopy), 4. Focus (Focused/Distracted/Tilted Away). Detection Priority: If eyelids appear heavy, droopy, or halfway closed, mark Blinking as 'Heavy/Droopy'. Return JSON." }
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

  const getFrac = (arr: string[], top: string, mid: string) => {
    if (arr.length === 0) return "0.0/10";
    const s = arr.reduce((a, v) => v.toLowerCase() === top.toLowerCase() ? a + 10 : (v.toLowerCase() === mid.toLowerCase() ? a + 5 : a), 0);
    return `${(s / arr.length).toFixed(1)}/10`;
  };

  const openReportInNewWindow = (history: ProAnalysis[], totalMinutes: number) => {
    const avgScore = Math.round(history.reduce((acc, curr) => acc + calculateAuditScore(curr), 0) / history.length);
    const nS = getFrac(history.map(a => a.neckAngle.status), 'Optimal', 'Strained');
    const dS = getFrac(history.map(a => a.distance.status), 'Perfect', 'Close');
    const bS = getFrac(history.map(a => a.blinking.status), 'Normal', 'Slow');
    const fS = getFrac(history.map(a => a.focus.status), 'Focused', 'Distracted');

    const details = [
      { 
        score: parseFloat(nS), label: "Postural Integrity", rec: "Elevate monitor to eye level and utilize lumbar support.", 
        why: "Continuous forward head tilt (text neck) places extreme torque on the cervical vertebrae. For every inch your head moves forward, it gains 10 lbs of effective weight, causing chronic disc degeneration and nerve impingement." 
      },
      { 
        score: parseFloat(dS), label: "Visual Proximity", rec: "Maintain an arm's length (50-70cm) from display surfaces.", 
        why: "Close-range viewing triggers excessive convergence and accommodation. This constant muscular effort leads to 'Astenopia', characterized by orbital pain, light sensitivity, and long-term changes in corneal curvature." 
      },
      { 
        score: parseFloat(bS), label: "Ocular Health & Blink Rate", rec: "Take a 5-minute screen break or use hydrating eye drops.", 
        why: "A low blink rate or 'heavy/droopy' eyelids signal severe ocular surface dehydration and cognitive fatigue. Blinking is the only way to re-lubricate the eye; failure results in inflammation and meibomian gland dysfunction." 
      },
      { 
        score: parseFloat(fS), label: "Cognitive Alignment", rec: "Minimize environmental stimuli and peripheral distractions.", 
        why: "Lateral gaze shifts and micro-distractions trigger 'Context Switching' penalties. This exhausts the prefrontal cortex, significantly reducing the quality of deep work and increasing the probability of errors." 
      }
    ];

    const reportHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Tenjin's Vision: Post-Session Audit</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
        <style>
          body { background: #020202; color: #fff; font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
          .container-box { background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 2rem; width: 100%; max-width: 650px; padding: 2.5rem; box-shadow: 0 50px 120px rgba(0,0,0,1); }
          .pill { background: #111; border: 1px solid #222; border-radius: 1.25rem; padding: 1.25rem; text-align: center; }
          .score-val { color: #818cf8; font-weight: 900; font-size: 1.75rem; line-height: 1; }
          .why-section { border-left: 4px solid #4f46e5; background: #0d0d0d; padding: 1.25rem; margin-top: 1rem; border-radius: 0 1rem 1rem 0; }
        </style>
      </head>
      <body>
        <div class="container-box space-y-10 animate-in fade-in slide-in-from-bottom-6 duration-1000">
          <header class="flex justify-between items-end border-b border-white/5 pb-8">
            <div>
              <p class="text-indigo-400 font-black uppercase tracking-[0.4em] text-[10px] mb-2">Workspace Insight Report</p>
              <h1 class="text-3xl font-black italic tracking-tighter uppercase text-white">Tenjin's Vision Audit</h1>
              <p class="text-gray-500 text-xs mt-2 font-bold uppercase tracking-widest">Active Monitoring: ${totalMinutes}m</p>
            </div>
            <div class="text-right">
              <span class="text-6xl font-black ${avgScore >= 80 ? 'text-emerald-500' : 'text-amber-500'} tracking-tighter">${avgScore}%</span>
              <p class="text-[10px] font-black text-gray-700 uppercase tracking-widest mt-1">Final Index</p>
            </div>
          </header>

          <div class="grid grid-cols-4 gap-4">
            <div class="pill"><p class="text-[9px] font-black text-gray-600 uppercase mb-2 tracking-widest">Neck</p><p class="score-val">${nS}</p></div>
            <div class="pill"><p class="text-[9px] font-black text-gray-600 uppercase mb-2 tracking-widest">Dist</p><p class="score-val">${dS}</p></div>
            <div class="pill"><p class="text-[9px] font-black text-gray-600 uppercase mb-2 tracking-widest">Eyes</p><p class="score-val">${bS}</p></div>
            <div class="pill"><p class="text-[9px] font-black text-gray-600 uppercase mb-2 tracking-widest">Focus</p><p class="score-val">${fS}</p></div>
          </div>

          <section class="space-y-8">
            <h3 class="text-[11px] font-black text-indigo-500 uppercase tracking-[0.4em]">Optimization Strategy & Pathogenesis</h3>
            <div class="space-y-6">
              ${details.map(d => `
                <div class="group">
                  <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-black text-gray-200 uppercase tracking-tight">${d.label}</span>
                    <span class="text-xs font-bold ${d.score >= 8.5 ? 'text-emerald-500' : (d.score >= 6 ? 'text-amber-500' : 'text-rose-500')}">${d.score}/10</span>
                  </div>
                  <p class="text-xs text-indigo-200/90 mb-3 font-semibold leading-relaxed">• ${d.rec}</p>
                  <div class="why-section shadow-sm">
                    <p class="text-[10px] font-black text-gray-500 uppercase mb-2 tracking-widest flex items-center gap-2">
                      <span class="w-1.5 h-1.5 rounded-full bg-indigo-600"></span> Clinical Rationale
                    </p>
                    <p class="text-[11px] text-gray-400 leading-relaxed font-medium">${d.why}</p>
                  </div>
                </div>
              `).join('')}
            </div>
          </section>

          <footer class="pt-8 border-t border-white/5 text-center">
            <p class="text-[9px] font-black text-gray-800 uppercase tracking-[0.6em]">Powered by Tenjin Vision AI Engine</p>
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
    setMetrics({
      posture: 'Unknown', distance: 0, blinksPerMinute: 0, isFocused: true, isTired: false,
      feedback: 'Session archived.', timestamp: Date.now(), currentAuditScore: 0, sessionAvgScore: 0
    });
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
          systemInstruction: `Tenjin's Vision Monitor. Report workspace ergonomics every 10 seconds. Focus on detecting Neck Posture, Screen Distance, and Blinking (specifically if eyelids are droopy/heavy). No audio feedback unless triggered.`,
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
                if (ctx) {
                  ctx.drawImage(videoRef.current, 0, 0, 1280, 720);
                  const base64 = canvasRef.current.toDataURL('image/jpeg', 0.6).split(',')[1];
                  sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } }));
                }
              }
            }, 1000 / FRAME_RATE);

            snapshotTimerRef.current = window.setInterval(() => {
              if (canvasRef.current) canvasRef.current.toBlob(b => b && performProAnalysis(b), 'image/jpeg', 0.8);
            }, PRO_SNAPSHOT_INTERVAL);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
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
      {/* Top Notification Toast */}
      <div className={`fixed top-12 left-1/2 -translate-x-1/2 z-[250] w-full max-w-lg px-6 transition-all duration-700 ${activeToast ? 'translate-y-0 opacity-100 scale-100' : '-translate-y-40 opacity-0 scale-95 pointer-events-none'}`}>
        <div className="bg-rose-600 text-white rounded-[1.5rem] p-6 shadow-[0_40px_80px_-15px_rgba(225,29,72,0.8)] flex items-start gap-5 border border-rose-400/30 backdrop-blur-md">
          <div className="bg-white/20 p-3 rounded-2xl text-2xl flex-shrink-0">⚠️</div>
          <div className="flex-1">
            <h4 className="text-[12px] font-black uppercase tracking-[0.3em] mb-1">Tenjin Warning</h4>
            <p className="text-[14px] font-semibold leading-relaxed opacity-95">{activeToast?.message}</p>
          </div>
        </div>
      </div>

      <GlobalStatusBar proInsight={proInsight} metrics={metrics} isActive={status === ConnectionStatus.CONNECTED} onTogglePiP={() => {}} />
      
      <main className="pt-20 pb-12 px-4 md:px-8 max-w-[1920px] mx-auto">
        <div className="flex flex-col gap-8">
          {status === ConnectionStatus.CONNECTED && <SessionLiveSummary history={history} wellnessHistory={wellnessHistory} metrics={metrics} />}
          
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
            <div className="xl:col-span-8 space-y-8 h-full">
              <CameraPreview videoRef={videoRef} canvasRef={canvasRef} isActive={status === ConnectionStatus.CONNECTED} />
              <Dashboard metrics={metrics} isActive={status === ConnectionStatus.CONNECTED} />
            </div>
            
            <div className="xl:col-span-4 flex flex-col gap-8 h-full">
              <ProInsightCard insight={proInsight} isAnalyzing={isAnalyzingPro} />
              
              <div className="bg-[#0c0c0c] border border-white/5 rounded-[3rem] p-10 flex flex-col items-center gap-8 shadow-2xl">
                {status !== ConnectionStatus.CONNECTED ? (
                  <div className="w-full space-y-6">
                    <div className="text-center">
                       <h3 className="text-lg font-black text-white uppercase tracking-tighter mb-2 italic">Vision Initialization</h3>
                       <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest leading-relaxed">Protect your visual and physical integrity with Tenjin AI Monitoring.</p>
                    </div>
                    <button 
                      onClick={startSession} 
                      className="w-full py-6 bg-indigo-600 rounded-[1.5rem] text-lg font-black uppercase italic tracking-tighter hover:bg-indigo-500 transition-all shadow-[0_0_50px_-10px_rgba(79,70,229,0.7)] hover:scale-[1.02]"
                    >
                      Enable Tenjin Vision
                    </button>
                  </div>
                ) : (
                  <div className="w-full space-y-6">
                    <div className="flex justify-between items-center mb-2 px-2">
                       <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest animate-pulse">Live Scan Online</span>
                       <span className="text-[9px] font-black text-gray-700 uppercase tracking-widest">Protocol v4.0</span>
                    </div>
                    <button 
                      onClick={stopSession} 
                      className="w-full py-6 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-[1.5rem] text-lg font-black uppercase italic tracking-tighter hover:bg-rose-500/20 transition-all hover:scale-[0.98]"
                    >
                      Terminate Protocol
                    </button>
                  </div>
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
