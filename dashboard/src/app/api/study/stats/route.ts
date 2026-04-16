import {
  getRetentionRate,
  getBloomDistribution,
  getMethodEffectiveness,
  getActivityTimeSeries,
  getCalibrationData,
} from '@/lib/study-db';

/**
 * GET /api/study/stats?days=7
 *
 * Returns combined analytics for the given time window (defaults to 7 days).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Math.max(1, parseInt(searchParams.get('days') ?? '7', 10) || 7);

    const from = new Date(Date.now() - days * 86400000).toISOString();
    const to = new Date().toISOString();

    const [retentionRate, bloomDistribution, methodEffectiveness, activityTimeSeries, calibration] =
      await Promise.all([
        Promise.resolve(getRetentionRate(days)),
        Promise.resolve(getBloomDistribution(days)),
        Promise.resolve(getMethodEffectiveness(days)),
        Promise.resolve(getActivityTimeSeries(days)),
        Promise.resolve(getCalibrationData(days)),
      ]);

    return Response.json({
      retentionRate,
      bloomDistribution,
      methodEffectiveness,
      activityTimeSeries,
      calibration,
      period: { days, from, to },
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
