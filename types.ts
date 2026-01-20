
export interface TranscriptionResult {
  text: string;
  status: 'idle' | 'recording' | 'processing' | 'done' | 'error';
  error?: string;
}

export interface AudioMetadata {
  duration: number;
  blob: Blob;
  url: string;
}
