import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// Helper function to parse simple cron-like schedules
function parseSchedule(schedule: string): Date {
  const now = new Date();
  const nextRun = new Date(now);

  // Support simple formats like:
  // "daily" - run at midnight
  // "hourly" - run at start of next hour
  // "every-5-minutes" - run in 5 minutes
  // "HH:MM" - run at specific time today/tomorrow (e.g., "14:30")
  
  if (schedule === 'hourly') {
    nextRun.setHours(nextRun.getHours() + 1, 0, 0, 0);
  } else if (schedule === 'daily') {
    nextRun.setDate(nextRun.getDate() + 1);
    nextRun.setHours(0, 0, 0, 0);
  } else if (schedule.startsWith('every-') && schedule.endsWith('-minutes')) {
    const minutes = parseInt(schedule.replace('every-', '').replace('-minutes', ''));
    nextRun.setMinutes(nextRun.getMinutes() + minutes, 0, 0);
  } else if (/^\d{1,2}:\d{2}$/.test(schedule)) {
    // Parse HH:MM format
    const [hours, minutes] = schedule.split(':').map(Number);
    nextRun.setHours(hours, minutes, 0, 0);
    
    // If time has passed today, schedule for tomorrow
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }
  } else {
    // Default: 1 hour from now
    nextRun.setHours(nextRun.getHours() + 1, 0, 0, 0);
  }

  return nextRun;
}

// Combined step that calculates next run and does the work
const scheduledTask = createStep({
  id: 'scheduled-task',
  description: 'Calculates next run time, waits, and executes the task',
  inputSchema: z.object({
    schedule: z.string(),
    taskName: z.string().optional(),
    maxIterations: z.number().optional(),
    iteration: z.number().optional(),
  }),
  outputSchema: z.object({
    schedule: z.string(),
    taskName: z.string(),
    maxIterations: z.number().optional(),
    iteration: z.number(),
    executedAt: z.string(),
    nextRunTime: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { schedule, taskName = 'Scheduled Task', maxIterations, iteration: prevIteration } = inputData;
    
    // Increment iteration count
    const iteration = (prevIteration || 0) + 1;
    
    // Calculate next run time
    const nextRunTime = parseSchedule(schedule);
    const currentTime = new Date();
    
    // Wait until the scheduled time
    const waitMs = nextRunTime.getTime() - currentTime.getTime();
    if (waitMs > 0) {
      console.log(`[${taskName}] Waiting ${Math.round(waitMs / 1000)}s until next run...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    
    // Execute the actual task
    const executionTime = new Date().toISOString();
    console.log(`[${taskName}] Executing task at ${executionTime}`);
    
    // This is where your actual work would go
    // For demonstration, just log the execution
    
    console.log(`[${taskName}] Task completed successfully`);
    if (maxIterations) {
      console.log(`[${taskName}] Progress: ${iteration}/${maxIterations}`);
    }
    
    // Return all input fields plus execution results so next iteration has what it needs
    return {
      schedule,
      taskName,
      maxIterations,
      iteration,
      executedAt: executionTime,
      nextRunTime: nextRunTime.toISOString(),
    };
  },
});

export const scheduledWorkflow = createWorkflow({
  id: 'scheduled-workflow',
  description: 'A workflow that runs on a recurring schedule',
  inputSchema: z.object({
    schedule: z.string().describe('Schedule format: "hourly", "daily", "every-N-minutes", or "HH:MM"'),
    taskName: z.string().optional().describe('Name of the scheduled task'),
    maxIterations: z.number().optional().describe('Maximum number of times to run (leave empty for infinite)'),
  }),
  outputSchema: z.object({
    schedule: z.string(),
    taskName: z.string(),
    maxIterations: z.number().optional(),
    iteration: z.number(),
    executedAt: z.string(),
    nextRunTime: z.string(),
  }),
})
  .dowhile(
    scheduledTask,
    async ({ inputData }) => {
      const { maxIterations, iteration } = inputData as { maxIterations?: number; iteration?: number };
      
      // If no max iterations specified, run forever
      if (!maxIterations) {
        return true;
      }
      
      // Otherwise, check if we've hit the limit
      return (iteration || 0) < maxIterations;
    }
  )
  .commit();


