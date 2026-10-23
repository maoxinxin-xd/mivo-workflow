import { createContext, useContext } from 'react';
import type { FreeLayoutPluginContext } from '@flowgram.ai/free-layout-editor';
import type { Environment, RunSnapshot, Workflow } from './model';

export interface StudioState {
  workflow: Workflow;
  environment: Environment;
  selectedId: string | undefined;
  snapshot: RunSnapshot | undefined;
  running: boolean;
  select: (id: string | undefined) => void;
  run: (id?: string) => void;
  save: (ctx: FreeLayoutPluginContext) => void;
  notify: (message: string) => void;
}

export const StudioContext = createContext<StudioState>(null!);
export const useStudio = () => useContext(StudioContext);
