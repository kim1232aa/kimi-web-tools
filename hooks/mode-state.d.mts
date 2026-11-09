export interface ModeDocument {
  globalMode: "auto" | "required" | "off";
  activeSessionId?: string;
  sessions: Record<string, any>;
  updatedAt: number;
}

export function positiveInteger(value: unknown, name: string, maximum?: number): number | undefined;
export function webToolsDir(): string;
export function readModeState(file?: string): ModeDocument;
export function updateModeState<T extends ModeDocument = ModeDocument>(file: string, change: (document: T) => void): T;
export function effectiveMode(document: ModeDocument, sessionId: string): "auto" | "required" | "off";
export function newTurn(document: ModeDocument, sessionId: string): {
  turn: number;
  required: boolean;
  disabled: boolean;
  webSearchCompleted: boolean;
  webSearchSucceeded: boolean;
  webFetchCompleted: boolean;
  webFetchSucceeded: boolean;
  correctionCount: number;
};
export function classifyOwnTool(name: string): "web_search" | "web_fetch" | undefined;
export function hookPayload(): Promise<Record<string, any>>;
export function hookFailure(error: unknown): void;
