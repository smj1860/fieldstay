import { registerOTel } from '@vercel/otel'

export function register() {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'fieldstay',
    instrumentationConfig: {
      fetch: {
        // Propagate trace context to Supabase and Inngest so spans chain correctly
        propagateContextUrls: [
          'supabase.co',
          'api.inngest.com',
          'inn.gs',
        ],
        // Don't trace push notification sends or Resend — high volume, low signal
        ignoreUrls: [
          'fcm.googleapis.com',
          'api.resend.com',
          'in.logs.betterstack',
        ],
      },
    },
  })
}
