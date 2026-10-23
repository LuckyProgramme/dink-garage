export const GOOGLE_CALLBACK_PATH = "/api/integrations/google/callback";
export const LOCAL_GOOGLE_REDIRECT_URI =
  `http://127.0.0.1:3000${GOOGLE_CALLBACK_PATH}`;

type RedirectEnvironment = Partial<
  Record<
    | "APP_ORIGIN"
    | "GOOGLE_REDIRECT_URI"
    | "NODE_ENV"
    | "VERCEL"
    | "VERCEL_ENV",
    string
  >
>;

function hostedOrigin(environment: RedirectEnvironment) {
  const configured = environment.APP_ORIGIN?.trim();
  if (!configured) throw new Error("google_redirect_invalid");
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw new Error("google_redirect_invalid");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== configured.replace(/\/$/, "") ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("google_redirect_invalid");
  return origin.origin;
}

export function googleRedirectUri(
  environment: RedirectEnvironment = process.env,
) {
  const isVercel =
    environment.VERCEL === "1" || Boolean(environment.VERCEL_ENV);
  const isDeployed = isVercel || environment.NODE_ENV === "production";
  const appOrigin = isDeployed ? hostedOrigin(environment) : "";
  const configured = isDeployed
    ? `${appOrigin}${GOOGLE_CALLBACK_PATH}`
    : environment.GOOGLE_REDIRECT_URI?.trim() || LOCAL_GOOGLE_REDIRECT_URI;
  let redirect: URL;
  try {
    redirect = new URL(configured);
  } catch {
    throw new Error("google_redirect_invalid");
  }

  const localHost = ["127.0.0.1", "localhost"].includes(redirect.hostname);
  if (
    redirect.pathname !== GOOGLE_CALLBACK_PATH ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password ||
    (redirect.protocol !== "https:" && !(localHost && redirect.protocol === "http:")) ||
    (isDeployed && redirect.origin !== appOrigin)
  )
    throw new Error("google_redirect_invalid");

  return redirect.toString();
}
