
export interface ProAnalysis {
  neckAngle: { status: 'Optimal' | 'Strained' | 'Poor'; message: string };
  distance: { status: 'Perfect' | 'Close' | 'Too Close'; message: string };
  blinking: { status: 'Normal' | 'Slow' | 'Dry Eyes'; message: string };
  focus: { status: 'Focused' | 'Distracted' | 'Tilted Away'; message: string };
  summary: string;
}

export interface WorkspaceMetrics {
  posture: 'Good' | 'Slouching' | 'Forward Head' | 'Unknown';
  distance: number; 
  blinksPerMinute: number;
  isFocused: boolean;
  isTired: boolean;
  feedback: string;
  timestamp: number;
  currentAuditScore: number;
  sessionAvgScore: number;
}

export interface SessionReport {
  totalMinutes: number;
  postureDistribution: Record<string, number>;
  distanceDistribution: Record<string, number>;
  blinkDistribution: Record<string, number>;
  focusDistribution: Record<string, number>;
  totalAudits: number;
  avgScore: number;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
