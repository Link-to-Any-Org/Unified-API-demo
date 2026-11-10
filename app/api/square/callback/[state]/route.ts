// The OAuth return URL used to be /api/square/callback, and that path may
// already be registered with the provider as this app's success URL. Keep it
// answering with the same handler so existing registrations keep working; new
// setups should register /api/connect/callback.
export { GET } from "@/app/api/connect/callback/[state]/route";
