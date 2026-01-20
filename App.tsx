
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, Square, Trash2, FileText, AlertCircle, Music, FileJson, Clock, RefreshCw, Zap, AlignLeft, Monitor, Smartphone, Volume2, Youtube, Film, FileAudio, ExternalLink, Upload } from 'lucide-react';
import { GoogleGenAI, Modality } from '@google/genai';
import { downloadTextFile, downloadAudioFile, formatDuration } from './utils/fileUtils';
import Visualizer from './components/Visualizer';
import { AudioMetadata } from './types';

// 오디오 인코딩 유틸리티 (PCM 16-bit to Base64)
const encode = (bytes: Uint8Array) => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

type SourceMode = 'mic' | 'youtube' | 'video' | 'audio';

const App: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioData, setAudioData] = useState<AudioMetadata | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [transcribedText, setTranscribedText] = useState<string>('');
  const [sourceMode, setSourceMode] = useState<SourceMode>('mic');
  const [isMobile, setIsMobile] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const wakeLockRef = useRef<any>(null);
  const textEndRef = useRef<HTMLDivElement>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const fileAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => {
    setIsMobile(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent));
    return () => stopRecording();
  }, []);

  useEffect(() => {
    if (textEndRef.current) {
      textEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcribedText]);

  const requestWakeLock = async () => {
    if ('wakeLock' in navigator && (navigator as any).wakeLock) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      } catch (err) {}
    }
  };

  const stopRecording = useCallback(() => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (fileAudioSourceRef.current) {
        fileAudioSourceRef.current.stop();
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
      
      setIsRecording(false);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      sessionPromiseRef.current = null;
      setStream(null);
    }
  }, [isRecording]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const startRecording = async () => {
    try {
      let captureStream: MediaStream | null = null;
      let audioBuffer: AudioBuffer | null = null;
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      if (sourceMode === 'mic') {
        captureStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } else if (sourceMode === 'youtube') {
        if (!isMobile) {
          captureStream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: 1, height: 1 },
            audio: { echoCancellation: false, noiseSuppression: false }
          });
        } else {
          captureStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      } else if (sourceMode === 'audio' || sourceMode === 'video') {
        if (!selectedFile) {
          alert("파일을 먼저 선택해주세요.");
          audioCtx.close();
          return;
        }
        const arrayBuffer = await selectedFile.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      }

      setStream(captureStream);
      setTranscribedText('');
      setRecordingTime(0);

      // 1. Gemini Live API 연결
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `너는 오디오 실시간 받아쓰기 전문가야. ${sourceMode === 'youtube' ? '유튜브 영상' : sourceMode === 'audio' || sourceMode === 'video' ? '미디어 파일' : '대화'}의 내용을 정확하게 한국어 텍스트로 변환해줘. 문맥을 파악해서 읽기 좋게 다듬어줘.`
        },
        callbacks: {
          onmessage: async (message) => {
            if (message.serverContent?.inputTranscription) {
              setTranscribedText(prev => prev + message.serverContent.inputTranscription.text);
            }
          },
          onerror: (e) => console.error("Gemini Error:", e),
          onclose: () => stopRecording()
        }
      });
      sessionPromiseRef.current = sessionPromise;

      // 2. 오디오 데이터 스트리밍 처리
      const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const l = inputData.length;
        const int16 = new Int16Array(l);
        for (let i = 0; i < l; i++) {
          int16[i] = inputData[i] * 32768;
        }
        const base64Data = encode(new Uint8Array(int16.buffer));
        sessionPromiseRef.current?.then(session => {
          session.sendRealtimeInput({
            media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
          });
        });
      };

      if (captureStream) {
        const source = audioCtx.createMediaStreamSource(captureStream);
        source.connect(scriptProcessor);
        scriptProcessor.connect(audioCtx.destination);

        const mediaRecorder = new MediaRecorder(captureStream);
        mediaRecorderRef.current = mediaRecorder;
        chunksRef.current = [];
        mediaRecorder.ondataavailable = (e) => chunksRef.current.push(e.data);
        mediaRecorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: 'audio/mp3' });
          const url = URL.createObjectURL(blob);
          setAudioData({ blob, url, duration: recordingTime });
          downloadAudioFile(blob, `필통_${sourceMode}_${formatDuration(recordingTime)}.mp3`);
        };
        mediaRecorder.start();
      } else if (audioBuffer) {
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(scriptProcessor);
        scriptProcessor.connect(audioCtx.destination);
        source.connect(audioCtx.destination); // 모니터링용 소리 재생
        fileAudioSourceRef.current = source;
        source.start();
        source.onended = () => stopRecording();
      }

      setIsRecording(true);
      await requestWakeLock();
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

    } catch (err) {
      console.error("실패:", err);
      alert("권한 거부 또는 오류가 발생했습니다.");
    }
  };

  const handleOpenYoutube = () => {
    if (youtubeUrl) {
      window.open(youtubeUrl, '_blank');
    } else {
      window.open('https://www.youtube.com', '_blank');
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col items-center p-4 sm:p-6 md:p-10">
      <header className="w-full max-w-3xl mt-2 mb-8 text-center">
        <div className="inline-flex items-center gap-2 bg-blue-600/5 px-4 py-2 rounded-full border border-blue-100 mb-5">
          <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-blue-600'}`}></div>
          <span className="text-[10px] font-black text-blue-700 uppercase tracking-[0.2em]">Piltong Multi-Source Transcriber</span>
        </div>
        <h1 className="text-4xl md:text-5xl font-black text-slate-900 tracking-tighter">
          필통 <span className="text-blue-600">녹음기 PRO</span>
        </h1>
        <p className="text-slate-400 font-bold text-sm mt-3 uppercase tracking-tighter">모든 소리를 실시간 텍스트로</p>
      </header>

      <main className="w-full max-w-3xl bg-white rounded-[56px] shadow-2xl shadow-blue-900/10 border border-white overflow-hidden flex flex-col relative">
        {/* 모드 선택 섹션 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-4 bg-slate-50/80 border-b border-slate-100">
          <button 
            disabled={isRecording}
            onClick={() => setSourceMode('mic')}
            className={`py-4 rounded-[24px] flex flex-col items-center gap-2 font-black text-[10px] transition-all ${sourceMode === 'mic' ? 'bg-white shadow-lg text-blue-600 border border-blue-50 scale-105' : 'text-slate-400 opacity-60'}`}
          >
            <Mic className="w-5 h-5" />
            마이크
          </button>
          <button 
            disabled={isRecording}
            onClick={() => setSourceMode('youtube')}
            className={`py-4 rounded-[24px] flex flex-col items-center gap-2 font-black text-[10px] transition-all ${sourceMode === 'youtube' ? 'bg-white shadow-lg text-red-600 border border-red-50 scale-105' : 'text-slate-400 opacity-60'}`}
          >
            <Youtube className="w-5 h-5" />
            유튜브
          </button>
          <button 
            disabled={isRecording}
            onClick={() => setSourceMode('video')}
            className={`py-4 rounded-[24px] flex flex-col items-center gap-2 font-black text-[10px] transition-all ${sourceMode === 'video' ? 'bg-white shadow-lg text-indigo-600 border border-indigo-50 scale-105' : 'text-slate-400 opacity-60'}`}
          >
            <Film className="w-5 h-5" />
            동영상 파일
          </button>
          <button 
            disabled={isRecording}
            onClick={() => setSourceMode('audio')}
            className={`py-4 rounded-[24px] flex flex-col items-center gap-2 font-black text-[10px] transition-all ${sourceMode === 'audio' ? 'bg-white shadow-lg text-emerald-600 border border-emerald-50 scale-105' : 'text-slate-400 opacity-60'}`}
          >
            <FileAudio className="w-5 h-5" />
            음성 파일
          </button>
        </div>

        {/* 상세 설정 영역 */}
        <div className="px-8 pt-8 flex flex-col gap-4">
          {sourceMode === 'youtube' && (
            <div className="flex gap-2 animate-in fade-in slide-in-from-top-2">
              <input 
                type="text" 
                placeholder="유튜브 주소를 입력하세요 (선택)" 
                className="flex-1 px-5 py-3 rounded-2xl bg-slate-50 border border-slate-100 text-sm focus:ring-2 ring-blue-100 outline-none"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
              />
              <button onClick={handleOpenYoutube} className="p-3 bg-red-50 text-red-600 rounded-2xl hover:bg-red-100 transition-colors">
                <ExternalLink className="w-5 h-5" />
              </button>
            </div>
          )}
          {(sourceMode === 'audio' || sourceMode === 'video') && (
            <div className="animate-in fade-in slide-in-from-top-2">
              <label className="flex items-center justify-center gap-3 w-full p-4 border-2 border-dashed border-slate-200 rounded-3xl cursor-pointer hover:bg-slate-50 transition-all text-slate-500 font-bold text-sm">
                <Upload className="w-5 h-5" />
                {selectedFile ? selectedFile.name : `${sourceMode === 'video' ? '동영상' : '음성'} 파일 선택하기`}
                <input type="file" className="hidden" accept={sourceMode === 'video' ? 'video/*' : 'audio/*'} onChange={handleFileChange} />
              </label>
            </div>
          )}
        </div>

        <div className="p-8 md:p-12 flex flex-col items-center">
          <div className="relative mb-10">
            <button
              onClick={isRecording ? stopRecording : startRecording}
              className={`w-32 h-32 md:w-40 md:h-40 rounded-full flex items-center justify-center transition-all duration-700 transform active:scale-95 shadow-2xl ${
                isRecording 
                  ? 'bg-red-500 shadow-red-200 ring-[16px] ring-red-50' 
                  : 'bg-blue-600 shadow-blue-200 ring-[16px] ring-blue-50 hover:bg-blue-700'
              }`}
            >
              {isRecording ? <Square className="w-12 h-12 text-white fill-current" /> : <Mic className="w-12 h-12 text-white" />}
              {isRecording && <div className="absolute inset-0 rounded-full border-4 border-white/20 animate-ping"></div>}
            </button>
          </div>

          <div className="text-center w-full mb-8">
            <div className={`text-7xl md:text-8xl font-mono font-black tracking-tighter mb-4 ${isRecording ? 'text-red-500' : 'text-slate-900'}`}>
              {formatDuration(recordingTime)}
            </div>
            {isRecording && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-2 bg-blue-50 px-4 py-2 rounded-full text-blue-600 font-black text-[10px] uppercase animate-pulse">
                  <Zap className="w-3 h-3 fill-current" />
                  <span>Gemini 고정밀 AI 분석 가동 중</span>
                </div>
              </div>
            )}
          </div>

          <Visualizer stream={stream} isRecording={isRecording} />
        </div>

        {/* 텍스트 뷰어 */}
        <div className="px-6 pb-6 md:px-10 md:pb-10">
          <div className={`bg-slate-50 rounded-[40px] p-8 border transition-all duration-500 ${isRecording ? 'border-blue-100 ring-4 ring-blue-50' : 'border-slate-100 shadow-inner'}`}>
            <div className="flex items-center justify-between mb-4 border-b border-slate-200 pb-4">
              <div className="flex items-center gap-2">
                <AlignLeft className="w-4 h-4 text-blue-500" />
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Live Feed</span>
              </div>
              {isRecording && <RefreshCw className="w-3 h-3 text-blue-400 animate-spin" />}
            </div>

            <div className="h-64 overflow-y-auto text-slate-800 text-lg md:text-xl leading-relaxed font-medium scrollbar-hide">
              {transcribedText ? (
                <div className="whitespace-pre-wrap animate-in fade-in duration-500">
                  {transcribedText}
                  <div ref={textEndRef} className="h-4" />
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-200 italic">
                  <FileText className="w-12 h-12 mb-2 opacity-10" />
                  <p className="text-xs font-bold uppercase tracking-widest opacity-40">변환 결과가 여기에 표시됩니다</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-4">
            <button
              onClick={() => downloadTextFile(transcribedText, `필통_${sourceMode}_${formatDuration(recordingTime)}.txt`)}
              disabled={!transcribedText || isRecording}
              className={`w-full py-6 rounded-[32px] font-black flex items-center justify-center gap-3 transition-all text-xl shadow-xl ${
                !transcribedText || isRecording
                  ? 'bg-slate-100 text-slate-300 cursor-not-allowed shadow-none'
                  : 'bg-amber-400 text-white hover:bg-amber-500 shadow-amber-200 active:scale-95'
              }`}
            >
              <FileJson className="w-7 h-7" />
              받아쓰기 파일 저장
            </button>
            <p className="text-[10px] text-slate-400 font-bold text-center uppercase tracking-tighter">
              {sourceMode === 'youtube' && "PC: 시스템 오디오 공유를 통해 유튜브 소리를 직접 추출합니다."}
              {sourceMode === 'mic' && "주변의 목소리를 실시간으로 받아씁니다."}
              {(sourceMode === 'audio' || sourceMode === 'video') && "파일을 분석하여 실시간으로 텍스트를 생성합니다."}
            </p>
          </div>
        </div>
      </main>

      <footer className="mt-12 text-slate-300 text-[10px] font-black uppercase tracking-[0.5em] text-center">
        PILTONG PRO • HYBRID AI ENGINE
      </footer>
    </div>
  );
};

export default App;
