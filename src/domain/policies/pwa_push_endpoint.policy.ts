export const isAllowedPwaPushEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (host === "fcm.googleapis.com" ||
        host === "updates.push.services.mozilla.com" ||
        (host.endsWith(".notify.windows.com") && /^[a-z0-9.-]+$/.test(host)))
    );
  } catch {
    return false;
  }
};
