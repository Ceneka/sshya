/**
 * Shared fixtures for the bench scripts.
 *
 * Everything here is synthetic text: no network, no remote host, no file
 * outside the temp directory.
 */

/** One ~200-char nginx error-log line, for 64 KiB log scenarios. */
export const nginxLine = (i: number): string =>
  `2026/11/18 14:02:${String(i % 60).padStart(2, '0')} [error] 4242#4242: *${100000 + i} upstream timed out (110: Connection timed out) while reading response header from upstream, client: 203.0.113.${i % 255}, server: api.example.com, request: "GET /v1/orders?page=${i} HTTP/1.1", upstream: "http://10.0.0.12:8080/v1/orders?page=${i}", host: "api.example.com"\n`;

export const makeLog = (lines: number): string => {
  let text = '';
  for (let i = 0; i < lines; i += 1) text += nginxLine(i);
  return text;
};

/**
 * A realistic multi-vhost nginx config. `server_name app0.example.com` appears
 * exactly once, which makes it a good "edit one line" target.
 */
export const makeNginxConf = (targetBytes: number): string => {
  const block = (i: number) => `server {
    listen 80;
    server_name app${i}.example.com;
    access_log /var/log/nginx/app${i}.access.log;
    location / {
        proxy_pass http://10.0.0.${(i % 200) + 10}:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}

`;
  let config = '# managed by sshya bench\n';
  for (let i = 0; config.length < targetBytes; i += 1) config += block(i);
  return config;
};
