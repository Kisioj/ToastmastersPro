import type { MethodId } from './lib/voting';

export interface Env {
  DB: D1Database;
  /** R2 (zalecane, wymaga włączenia R2 w panelu Cloudflare) */
  FILES?: R2Bucket;
  /** Workers KV — zapasowy magazyn plików, działa bez karty */
  FILES_KV?: KVNamespace;
  AI?: Ai;

  /** docelowa domena — www.* i *.workers.dev przekierowują tutaj */
  CANONICAL_HOST?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  MAIL_FROM_NAME?: string;
  MAIL_DAILY_LIMIT?: string;

  AI_PROVIDER?: string;
  WORKERS_AI_MODEL?: string;
  CLAUDE_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  AI_DAILY_LIMIT?: string;
  AI_COOLDOWN_MINUTES?: string;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'member' | 'admin';
  password_hash: string | null;
  active: number;
  invited_at: number | null;
  last_login_at: number | null;
  created_at: number;
}

export type Phase = 'draft' | 'submissions' | 'voting' | 'closed';
export type ResultsMode = 'admin' | 'after_vote' | 'closed';

export interface ContestRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  kind: 'text' | 'rollup' | 'leaderboard';
  phase: Phase;
  methods: string;
  results: ResultsMode;
  settings: string;
  position: number;
  created_at: number;
}

export interface Contest extends Omit<ContestRow, 'methods' | 'settings'> {
  methods: MethodId[];
  settings: ContestSettings;
}

export interface ContestSettings {
  /** budżet punktów w metodzie "points" */
  points_budget?: number;
  /** maks. liczba zgłoszeń jednej osoby (rollup) */
  max_entries?: number;
  /** maks. rozmiar pliku w MB (rollup) */
  max_mb?: number;
  /** okres konkursu (RRRR-MM-DD), pokazywany na stronie */
  period_start?: string;
  period_end?: string;
  /** wymiary docelowe w mm (rollup) */
  width_mm?: number;
  height_mm?: number;
}

export interface EntryRow {
  id: number;
  contest_id: number;
  title: string;
  description: string;
  author_id: number | null;
  file_key: string | null;
  file_name: string | null;
  file_type: string | null;
  file_size: number | null;
  file_parts: number | null;
  upload_complete: number;
  preview_key: string | null;
  report: string | null;
  ai_report: string | null;
  hidden: number;
  position: number;
  created_at: number;
}

export type AppEnv = { Bindings: Env; Variables: { user: User | null; sessionHash: string | null } };
