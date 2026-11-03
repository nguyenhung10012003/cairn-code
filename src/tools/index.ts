import { bashTool } from './bash.ts';
import { cronCreateTool, cronDeleteTool, cronListTool } from './cron.ts';
import { editTool, readTool, writeTool } from './files.ts';
import { agentTool, askUserTool, enterPlanModeTool, exitPlanModeTool, listAgentsTool, sendMessageTool, todoWriteTool } from './interaction.ts';
import { monitorTool } from './monitor.ts';
import { notebookEditTool } from './notebook.ts';
import { globTool, grepTool } from './search.ts';
import { enterWorktreeTool, exitWorktreeTool, pushNotificationTool } from './session.ts';
import { taskStopTool } from './tasks.ts';
import type { Tool } from './types.ts';
import { webFetchTool } from './web.ts';

/** Stable order matters: the tool list is part of the prompt-cache prefix. */
export function builtinTools(): Tool[] {
  return [
    agentTool,
    askUserTool,
    bashTool,
    cronCreateTool,
    cronDeleteTool,
    cronListTool,
    editTool,
    enterPlanModeTool,
    enterWorktreeTool,
    exitPlanModeTool,
    exitWorktreeTool,
    globTool,
    grepTool,
    listAgentsTool,
    monitorTool,
    notebookEditTool,
    pushNotificationTool,
    readTool,
    sendMessageTool,
    taskStopTool,
    todoWriteTool,
    webFetchTool,
    writeTool,
  ];
}

/** Only an interactive session has someone at the keyboard, and an idle prompt for events to fire into. */
export const INTERACTIVE_ONLY_TOOLS = new Set(['CronCreate', 'CronDelete', 'CronList', 'PushNotification', 'Monitor']);
