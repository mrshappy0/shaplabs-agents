import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { forecastTool, planActivitiesTool } from '../tools/weather-tool';

const fetchWeather = createStep(forecastTool);

const planActivities = createStep(planActivitiesTool);

const weatherWorkflow = createWorkflow({
  id: 'weather-workflow',
  inputSchema: z.object({
    city: z.string().describe('The city to get the weather for'),
  }),
  outputSchema: z.object({
    activities: z.string(),
  }),
})
  .then(fetchWeather)
  .then(planActivities);

weatherWorkflow.commit();

export { weatherWorkflow };
