# IIS HTTPS 反向代理部署

本文说明如何在 Windows 上使用 IIS、URL Rewrite 和 Application Request Routing（ARR），把公开的 HTTPS 请求转发到仅监听 `127.0.0.1:3000` 的 GithubCopilotWebUI。工程不提供或维护 IIS 安装脚本及站点配置文件，以下操作由服务器管理员手工执行。

## 1. 拓扑和端口

```text
浏览器
  │ HTTPS / WSS :443
  ▼
IIS + URL Rewrite + ARR
  │ HTTP / WS 127.0.0.1:3000
  ▼
GithubCopilotWebUI
```

只对外开放 TCP 443。不要对外开放 3000、4000、4100 或 4200。

应用的 `.env` 应使用公开地址和内部 Web 端口：

```dotenv
PUBLIC_APP_URL=https://copilot.example.com
WEB_PORT=3000
```

GitHub App Homepage URL 和 Callback URL 必须使用相同的公开 HTTPS 域名，例如：

```text
https://copilot.example.com
https://copilot.example.com/api/auth/github/callback
```

## 2. 安装 IIS、URL Rewrite 和 ARR

从管理员 Windows PowerShell 启用 IIS 所需组件：

```powershell
$features = @(
  'IIS-WebServerRole',
  'IIS-WebServer',
  'IIS-CommonHttpFeatures',
  'IIS-HttpErrors',
  'IIS-StaticContent',
  'IIS-WebSockets',
  'IIS-ManagementConsole',
  'IIS-ManagementScriptingTools'
)

foreach ($feature in $features) {
  Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
}
```

然后按顺序安装 Microsoft 提供的组件：

1. [IIS URL Rewrite 2.1](https://www.iis.net/downloads/microsoft/url-rewrite)
2. [Application Request Routing 3.0](https://www.iis.net/downloads/microsoft/application-request-routing)

ARR 依赖 URL Rewrite，因此不能颠倒安装顺序。安装后在 IIS Manager 的服务器主页确认存在 **URL Rewrite** 和 **Application Request Routing Cache**。

## 3. 准备证书

生产环境应使用企业 CA 或公共 CA 签发、包含私钥且覆盖公开主机名的证书，并导入：

```text
Certificates (Local Computer)
└─ Personal
   └─ Certificates
```

仅在本机开发环境中，可以从管理员 PowerShell 创建并信任自签名证书：

```powershell
$hostName = 'copilot.example.com'
$certificate = New-SelfSignedCertificate `
  -DnsName $hostName `
  -CertStoreLocation 'Cert:\LocalMachine\My' `
  -FriendlyName "GithubCopilotWebUI local development ($hostName)" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(2)

$certificateFile = Join-Path $env:TEMP "$($certificate.Thumbprint).cer"
Export-Certificate -Cert $certificate -FilePath $certificateFile -Force
Import-Certificate `
  -FilePath $certificateFile `
  -CertStoreLocation 'Cert:\LocalMachine\Root'
Remove-Item -LiteralPath $certificateFile
```

不要把自签名证书用于面向真实用户的生产站点。

## 4. 启用 ARR 代理

打开 IIS Manager：

1. 选择服务器节点。
2. 打开 **Application Request Routing Cache**。
3. 在右侧选择 **Server Proxy Settings**。
4. 选中 **Enable proxy**。
5. 选中 **Preserve host header**。
6. 将 **Time-out (seconds)** 设置为 `1800`，以支持长时间运行的 SSE 和 WebSocket 连接。
7. 清除 **Reverse rewrite host in response headers**。
8. 点击 **Apply**。

也可以从管理员 PowerShell 使用：

```powershell
& "$env:SystemRoot\System32\inetsrv\appcmd.exe" set config `
  /section:system.webServer/proxy `
  /enabled:true `
  /preserveHostHeader:true `
  /reverseRewriteHostInResponseHeaders:false `
  /timeout:00:30:00 `
  /commit:apphost
```

## 5. 创建 IIS 站点

创建一个只用于保存 IIS 配置的目录，例如：

```powershell
New-Item -ItemType Directory -Path C:\IIS\GithubCopilotWebUI -Force
```

在该目录创建 `web.config`：

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <clear />
        <rule name="GithubCopilotWebUI reverse proxy" stopProcessing="true">
          <match url="(.*)" />
          <action
            type="Rewrite"
            url="http://127.0.0.1:3000/{R:1}"
            appendQueryString="true"
            logRewrittenUrl="true" />
        </rule>
      </rules>
    </rewrite>
    <httpErrors existingResponse="PassThrough" />
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="104857600" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

在 IIS Manager 中：

1. 创建应用程序池，例如 `GithubCopilotWebUI`。
2. 将 **.NET CLR version** 设置为 **No Managed Code**。
3. 创建站点，物理路径指向 `C:\IIS\GithubCopilotWebUI`。
4. 删除不需要的 HTTP 绑定。
5. 添加 HTTPS 绑定：
   - IP address：`All Unassigned`
   - Port：`443`
   - Host name：公开域名
   - 勾选 **Require Server Name Indication**
   - SSL certificate：选择与公开域名匹配的证书
6. 启动站点。

同一个主机名和端口只能由一个 IIS 站点占用。若已有站点使用该绑定，应更新现有站点，避免创建一个永远接收不到请求的新站点。

## 6. WebSocket 和 Next.js 热更新

ARR 3 会转发标准的 HTTP Upgrade 请求，因此应用 WebSocket 和 Next.js HMR 可以复用同一个 443 端口，无需开放额外端口。

生产模式 `next start` 不使用 `/_next/webpack-hmr`。如果必须通过 IIS 访问 `next dev`，还需把公开主机名加入 `apps/web/next.config.ts` 的 `allowedDevOrigins`，然后重启 Next.js：

```ts
const nextConfig = {
  allowedDevOrigins: ['copilot.example.com'],
}
```

不要在生产服务器长期运行 `next dev`。

## 7. 验证

先确认后端：

```powershell
Invoke-WebRequest http://127.0.0.1:3000
```

再确认 IIS：

```powershell
Invoke-WebRequest https://copilot.example.com
Get-Website
Get-WebBinding
```

预期后端和公开地址均返回 HTTP 200。WebSocket 成功时，浏览器开发者工具中的握手状态为 `101 Switching Protocols`。

## 8. 常见故障

### 502 Bad Gateway

- 确认 `127.0.0.1:3000` 正在监听。
- 确认 ARR 的 **Enable proxy** 已启用。
- 确认 `web.config` 的目标端口与 `WEB_PORT` 一致。

### 500 Internal Server Error

- 确认 URL Rewrite 和 ARR 都已安装。
- 检查站点物理路径是否指向包含正确 `web.config` 的目录。
- 检查 `web.config` 是否包含服务器级被锁定的配置节。
- 查看 IIS 日志、Failed Request Tracing 和 Windows Event Viewer。

### 证书错误或 TLS 握手失败

- 确认证书包含公开主机名、未过期且含私钥。
- 确认证书位于 `Local Computer\Personal`。
- 确认 HTTPS 绑定使用正确证书和 SNI 主机名。
- 确认没有其他站点抢占相同的 `主机名:443` 绑定。

### 页面正常但 HMR WebSocket 失败

- 确认安装了 ARR 3 和 `IIS-WebSockets` Windows 功能。
- 确认 ARR 超时时间足够长。
- 确认公开域名已加入 `allowedDevOrigins`。
- 确认浏览器连接的是 `wss://公开域名/_next/webpack-hmr`。

### SSE 经常断开

- 将 ARR 超时设置为足够长的时间。
- 避免在上游网络设备中缓冲流式响应。
- 检查企业网关、防火墙或负载均衡器是否有更短的空闲连接超时。
