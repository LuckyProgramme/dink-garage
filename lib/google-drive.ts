export class DriveError extends Error {
  constructor(public code: string, public retryable = false) { super(code); }
}
export function driveId(id: string) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(id)) throw new DriveError("invalid_drive_id");
  return id;
}
export function uploadUri(value: string) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.hostname !== "www.googleapis.com" || !u.pathname.startsWith("/upload/drive/v3/files") || u.username || u.password || u.port || u.hash)
    throw new DriveError("invalid_upload_address");
  return u.href;
}
export function localDay(date: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en", {timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(date));
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function compactFilePart(value: string, maxLength: number, fallback: string) {
  const cleaned = value
    .normalize("NFKC")
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned.slice(0, maxLength) || fallback;
}
export function recordingFileName(date: string, zone: string, court: string, recipient: string, extension: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(date));
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  const stamp = `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}${get("second")}`;
  const safeCourt = compactFilePart(court, 40, "Court");
  const safeRecipient = compactFilePart(recipient.toLowerCase(), 80, "player");
  const safeExtension = extension.toLowerCase().replace(/^\./, "");
  if (!/^(mp4|webm)$/.test(safeExtension)) throw new DriveError("invalid_video_extension");
  return `${stamp}_${safeCourt}_${safeRecipient}.${safeExtension}`;
}
type Permission = {id: string; type: string; role: string; emailAddress?: string; deleted?: boolean; allowFileDiscovery?: boolean};
export function privatePermissions(permissions: Permission[], owner: string, recipient?: string) {
  return permissions.length > 0 && permissions.every(p => !p.deleted && p.type === "user" && (
    (p.role === "owner" && p.emailAddress?.toLowerCase() === owner.toLowerCase()) ||
    (p.role === "reader" && !!recipient && p.emailAddress?.toLowerCase() === recipient.toLowerCase())
  ));
}
export class GoogleDrive {
  constructor(private token: string, private request: typeof fetch = fetch) {}
  async call(path: string, init: RequestInit = {}) {
    const r = await this.request(`https://www.googleapis.com/drive/v3/${path}`, {
      ...init, redirect:"error", signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${this.token}`,"Content-Type":"application/json",...init.headers},
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const reason = data.error?.errors?.[0]?.reason;
      if (r.status === 404) throw new DriveError("drive_file_missing");
      if (r.status === 401) throw new DriveError("google_reconnect_required");
      if (r.status === 409) throw new DriveError("drive_conflict", true);
      if (r.status === 429 || r.status >= 500 || ["rateLimitExceeded","userRateLimitExceeded"].includes(reason)) throw new DriveError("google_temporarily_unavailable", true);
      throw new DriveError(r.status === 403 ? "drive_access_or_quota" : "drive_request_rejected");
    }
    return r.status === 204 ? {} : r.json();
  }
  async newId(): Promise<string> {
    const data = await this.call("files/generateIds?count=1&space=drive&type=files");
    return driveId(data.ids[0]);
  }
  file(id: string) {
    return this.call(`files/${driveId(id)}?fields=id,mimeType,size,md5Checksum,parents,trashed,createdTime,capabilities(canAddChildren),owners(emailAddress)`);
  }
  async permissions(id: string): Promise<Permission[]> {
    const permissions: Permission[] = [];
    let page = "";
    do {
      const r = await this.call(`files/${driveId(id)}/permissions?fields=nextPageToken,permissions(id,type,role,emailAddress,deleted,allowFileDiscovery)&pageSize=100${page ? "&pageToken="+encodeURIComponent(page) : ""}`);
      permissions.push(...r.permissions); page = r.nextPageToken || "";
    } while (page);
    return permissions;
  }
  async privateFolder(id: string, owner: string) {
    const f = await this.file(id);
    if (f.trashed || f.mimeType !== "application/vnd.google-apps.folder" || !f.capabilities?.canAddChildren || !privatePermissions(await this.permissions(id),owner))
      throw new DriveError("drive_folder_must_be_private");
    return f;
  }
  async createFolder(id: string, root: string, name: string) {
    try {
      await this.call("files?fields=id", {method:"POST",body:JSON.stringify({id:driveId(id),name,mimeType:"application/vnd.google-apps.folder",parents:[driveId(root)]})});
    } catch (e) { if (!(e instanceof DriveError) || e.code !== "drive_conflict") throw e; }
    const folder = await this.file(id);
    if (!folder.parents?.includes(root)) throw new DriveError("drive_folder_mismatch");
  }
  async beginUpload(id: string, folder: string, name: string, bytes: number, mime = "video/mp4") {
    const r = await this.request("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
      method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${this.token}`,"Content-Type":"application/json","X-Upload-Content-Type":mime,"X-Upload-Content-Length":String(bytes)},
      body:JSON.stringify({id:driveId(id),name,mimeType:mime,parents:[driveId(folder)]}),
    });
    if (!r.ok) throw new DriveError(r.status===401?"google_reconnect_required":"upload_initialization_failed", r.status===429 || r.status>=500 || r.status===409);
    return uploadUri(r.headers.get("location") || "");
  }
  async shareLink(id: string, owner: string) {
    const acceptable = (items: Permission[]) => items.some(p => p.type === "user" && p.role === "owner" && p.emailAddress?.toLowerCase() === owner.toLowerCase()) && items.every(p => !p.deleted && ((p.type === "user" && p.role === "owner" && p.emailAddress?.toLowerCase() === owner.toLowerCase()) || (p.type === "anyone" && p.role === "reader" && p.allowFileDiscovery === false)));
    let permissions = await this.permissions(id);
    if (!acceptable(permissions)) throw new DriveError("unexpected_file_permissions");
    if (!permissions.some(p => p.type === "anyone")) await this.call(`files/${driveId(id)}/permissions?fields=id`, {method:"POST",body:JSON.stringify({type:"anyone",role:"reader",allowFileDiscovery:false})});
    permissions = await this.permissions(id);
    if (!acceptable(permissions)) throw new DriveError("unexpected_file_permissions");
    const permission = permissions.find(p => p.type === "anyone" && p.role === "reader");
    if (!permission) throw new DriveError("sharing_not_confirmed",true);
    return permission.id;
  }
  async share(id: string, owner: string, recipient: string) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || /@example\.(com|org|net)$/i.test(recipient)) throw new DriveError("real_player_email_required");
    let permissions = await this.permissions(id);
    if (!privatePermissions(permissions,owner,recipient)) throw new DriveError("drive_file_not_private");
    const existing = permissions.find(p => p.emailAddress?.toLowerCase() === recipient.toLowerCase());
    if (existing) return existing.id;
    await this.call(`files/${driveId(id)}/permissions?sendNotificationEmail=false&fields=id`, {
      method:"POST",body:JSON.stringify({type:"user",role:"reader",emailAddress:recipient}),
    });
    permissions = await this.permissions(id);
    if (!privatePermissions(permissions,owner,recipient)) throw new DriveError("drive_file_not_private");
    const permission = permissions.find(p => p.role === "reader" && p.emailAddress?.toLowerCase() === recipient.toLowerCase());
    if (!permission) throw new DriveError("sharing_not_confirmed",true);
    return permission.id;
  }
}
