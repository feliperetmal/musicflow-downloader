export type Platform = 'spotify' | 'youtube' | 'upload' | 'authorized_url' | 'unknown';

export type SpotifyResourceType = 'track' | 'album' | 'playlist' | 'share';

export type YouTubeResourceType =
  | 'video'
  | 'playlist'
  | 'shorts'
  | 'music_video'
  | 'music_playlist';

export type BitrateKbps = 128 | 192 | 256 | 320;

export type OutputFormat = 'mp3' | 'mp4';

export type ExportFormat = 'csv' | 'json' | 'm3u';

export type AudioSourceOrigin =
  | 'youtube_stream'
  | 'user_upload'
  | 'authorized_catalog'
  | 'direct_url'
  | 'none';

export interface AvailableFormatOption {
  id: string;
  format: OutputFormat;
  qualityLabel: string;
  bitrateKbps?: BitrateKbps;
  resolution?: string;
  fps?: number;
  containerLabel: string;
  estimatedSizeBytes?: number;
  videoItag?: number;
  audioItag?: number;
  requiresTranscode?: boolean;
  verifiedAvailable?: boolean;
  note?: string;
}

export interface ParsedMediaLink {
  raw: string;
  normalizedUrl: string;
  platform: Platform;
  resourceType: string;
  id?: string;
  playlistId?: string;
  isShareShortlink: boolean;
  isValid: boolean;
  error?: string;
}

export interface MediaItem {
  id: string;
  platform: Platform;
  resourceType: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  artist: string;
  album?: string;
  trackNumber?: number;
  durationSeconds?: number;
  coverUrl?: string;
  channelName?: string;
  releaseDate?: string;
  isrc?: string;
  licenseType?: 'creative_commons' | 'standard' | 'authorized';
  licenseNote?: string;
  sourceOrigin?: AudioSourceOrigin;
  downloadEligible: boolean;
  requiresAuthorizationConfirmation?: boolean;
  eligibilityReason: string;
  availableFormats?: AvailableFormatOption[];
  authorizedAudioUrl?: string;
  uploadId?: string;
  sourceFileName?: string;
}

export type CollectionAccessStatus = 'full' | 'partial' | 'restricted' | 'auth_required';

export interface CollectionResult {
  platform: Platform;
  resourceType: string;
  canonicalUrl: string;
  title: string;
  subtitle?: string;
  description?: string;
  ownerName?: string;
  ownerUrl?: string;
  coverUrl?: string;
  totalTracks: number;
  knownTotalTracks?: number;
  loadedTracks?: number;
  totalDurationSeconds?: number;
  accessStatus?: CollectionAccessStatus;
  restrictionReason?: string;
  requiresSpotifyLogin?: boolean;
  apiMode: 'official_api' | 'oembed_fallback' | 'direct_source' | 'stream_metadata';
  legalNotice: string;
  items: MediaItem[];
}

export interface PlaylistProgressEvent {
  type: 'progress' | 'complete' | 'error';
  loaded: number;
  total: number;
  stage: string;
  collection?: CollectionResult;
  error?: string;
}

export interface SpotifyAuthStatus {
  authenticated: boolean;
  clientConfigured: boolean;
  hasClientSecret: boolean;
  developmentMode: boolean;
  redirectUri: string;
  scopes: string[];
  expiresAt?: string;
  tokenValid: boolean;
  user?: {
    id: string;
    displayName: string;
    product?: string;
    country?: string;
  };
}

export interface DiagnosticHttpError {
  timestamp: string;
  source: 'youtube' | 'spotify' | 'authorized_url' | 'ffmpeg';
  statusCode?: number;
  message: string;
  latencyMs?: number;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  timestamp: string;
  workerStatus: 'ok' | 'degraded';
  ffmpeg: {
    available: boolean;
    ffprobeAvailable: boolean;
    concurrency: number;
    threads: number;
  };
  spotify: {
    clientConfigured: boolean;
    hasClientSecret: boolean;
    developmentMode: boolean;
    redirectUri: string;
    configuredScopes: string[];
    userAuthenticated: boolean;
    userTokenValid: boolean;
    userTokenExpiresAt?: string;
    grantedScopes: string[];
    knownLimits: string[];
  };
  youtube: {
    officialApiKeyConfigured: boolean;
    streamExtractorReady: boolean;
    ytDlpAvailable: boolean;
    ytDlpVersion?: string;
  };
  queues: {
    pending: number;
    processing: number;
    converting: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  recentHttpErrors: DiagnosticHttpError[];
  averageLatencyMs: {
    spotifyApi?: number;
    youtubeProbe?: number;
  };
}

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'converting'
  | 'tagging'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Id3MetadataInput {
  title: string;
  artist: string;
  album?: string;
  trackNumber?: number;
  coverUrl?: string;
}

export interface ConversionJobRequest {
  sourceType: 'upload' | 'authorized_url' | 'youtube' | 'spotify_track';
  outputFormat?: OutputFormat;
  uploadId?: string;
  authorizedAudioUrl?: string;
  youtubeVideoId?: string;
  searchQuery?: string;
  videoItag?: number;
  audioItag?: number;
  qualityLabel?: string;
  userConfirmedAuthorization?: boolean;
  bitrate: BitrateKbps;
  metadata: Id3MetadataInput;
  durationHintSeconds?: number;
}

export interface ConversionJob {
  id: string;
  status: JobStatus;
  progress: number;
  stageLabel: string;
  outputFormat: OutputFormat;
  qualityLabel: string;
  bitrate: BitrateKbps;
  sourceType: 'upload' | 'authorized_url' | 'youtube' | 'spotify_track';
  metadata: Id3MetadataInput;
  attempt: number;
  maxAttempts: number;
  error?: string;
  outputFilename?: string;
  outputSizeBytes?: number;
  downloadTicket?: string;
  sourceBitrateKbps?: number;
  bitrateNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadMetadata {
  uploadId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds?: number;
  sourceBitrateKbps?: number;
  codec?: string;
  createdAt: string;
}

export interface HostedZipResult {
  url: string;
  provider: 'catbox' | 'litterbox';
  fileName: string;
  sizeBytes: number;
  fileCount: number;
  expiresIn: string;
  copiedToClipboard?: boolean;
}
