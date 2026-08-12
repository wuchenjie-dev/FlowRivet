export interface GenericPackageClientOptions {
  baseUrl: string;
  projectId: string;
  deployToken: string;
  fetch?: typeof fetch;
  redirectHostAllowlist?: string[];
}

export class GenericPackageClient {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: URL;

  constructor(private readonly options: GenericPackageClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "https:") throw new Error("package_base_url_insecure");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  downloadChannelManifest(packageName: string, version: string): Promise<Uint8Array> {
    return this.downloadPackageFile(packageName, version, "manifest.json", 1_000_000);
  }

  downloadReleaseManifest(packageName: string, version: string): Promise<Uint8Array> {
    return this.downloadPackageFile(packageName, version, "release-manifest.json", 1_000_000);
  }

  async downloadPackageFile(packageName: string, version: string, file: string, maxBytes = 2_000_000_000): Promise<Uint8Array> {
    const url = this.packageUrl(packageName, version, file);
    let response = await this.fetch(url.href, {
      headers: { "DEPLOY-TOKEN": this.options.deployToken },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("package_redirect_invalid");
      const redirect = new URL(location, url);
      const allowlist = new Set(this.options.redirectHostAllowlist ?? []);
      if (redirect.protocol !== "https:" || (!allowlist.has(redirect.hostname) && redirect.origin !== this.baseUrl.origin)) {
        throw new Error("package_redirect_rejected");
      }
      response = await this.fetch(redirect.href, { redirect: "manual" });
    }
    if (!response.ok) throw new Error("package_download_rejected");
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) throw new Error("package_download_too_large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("package_download_too_large");
    return bytes;
  }

  private packageUrl(packageName: string, version: string, file: string): URL {
    const segments = [packageName, version, file];
    if (segments.some((segment) => !/^[0-9A-Za-z._-]+$/u.test(segment) || segment === "." || segment === "..")) {
      throw new Error("package_path_invalid");
    }
    return new URL(
      `/api/v4/projects/${encodeURIComponent(this.options.projectId)}/packages/generic/${segments.map(encodeURIComponent).join("/")}`,
      this.baseUrl,
    );
  }
}
