import { redirect } from 'next/navigation';

/**
 * Land on the operational view.
 *
 * The root used to be the system dashboard — kill switch, throughput charts,
 * execution feed. Useful, but not what anyone opens the app to find out. The
 * first question is always "would a signal trade right now, and if not why",
 * so that is what the root answers. The system view lives at /system.
 */
export default function RootPage() {
  redirect('/ops');
}
