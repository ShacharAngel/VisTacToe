import { buildReport } from '../src/feedback/report.js';

console.log(buildReport(process.env.VISTACTOE_DATA ?? 'data'));
