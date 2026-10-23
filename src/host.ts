import type { Environment } from './model';
export interface PublicSession {
  owner: string;
  userName: string;
  version: number;
}
export interface HostAdapter {
  getSession(environment: Environment): PublicSession | undefined;
  request(
    environment: Environment,
    path: string,
    signal: AbortSignal,
    body?: BodyInit,
    binary?: boolean,
  ): Promise<any>;
  llmConfigured(): boolean;
  llmRequest(path: string, body: unknown, signal: AbortSignal): Promise<any>;
  readCatalog(scope: string): Promise<any>;
  writeCatalog(scope: string, catalog: any): Promise<void>;
}
let adapter: HostAdapter | undefined;
export function configureHost(value: HostAdapter) {
  adapter = value;
}
export function getHost() {
  return adapter;
}
