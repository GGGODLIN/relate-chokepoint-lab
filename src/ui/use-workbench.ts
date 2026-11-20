import { useSyncExternalStore } from 'react';
import type { WorkbenchController, WorkbenchState } from './workbench-controller.ts';

export function useWorkbench(controller: WorkbenchController): WorkbenchState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
