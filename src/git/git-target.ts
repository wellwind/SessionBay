import { createContext } from 'react';

/** Project name of the Git workbench, so destructive confirmations always name their target. */
export const GitTargetContext = createContext<string | null>(null);
