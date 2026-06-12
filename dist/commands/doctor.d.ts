import type { DoctorOptions, DoctorReport } from '../types.js';
export declare function doctorProject(options?: DoctorOptions): Promise<DoctorReport>;
export declare function formatDoctorReport(report: DoctorReport): string;
