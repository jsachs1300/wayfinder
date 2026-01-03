# Nginx Reverse Proxy Setup Guide for Wayfinder

This guide provides comprehensive instructions for setting up Nginx as a reverse proxy for Wayfinder with HTTPS, security hardening, and production best practices.

---

## Table of Contents

1. [Why Use a Reverse Proxy?](#why-use-a-reverse-proxy)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Basic Configuration](#basic-configuration)
5. [SSL/TLS Setup with Let's Encrypt](#ssltls-setup-with-lets-encrypt)
6. [Production-Ready Configuration](#production-ready-configuration)
7. [Security Hardening](#security-hardening)
8. [Load Balancing (Optional)](#load-balancing-optional)
9. [Monitoring and Logs](#monitoring-and-logs)
10. [Troubleshooting](#troubleshooting)
11. [Alternative: Caddy](#alternative-caddy)

---

## Why Use a Reverse Proxy?

A reverse proxy like Nginx provides critical benefits:

- **SSL/TLS Termination**: Handle HTTPS certificates and encryption
- **Security**: Hide backend server details, prevent direct access
- **Performance**: Caching, compression, connection pooling
- **Flexibility**: Load balancing, multiple backends, URL rewriting
- **Best Practice**: Separation of concerns (Nginx handles HTTP, Wayfinder handles routing logic)

**Without HTTPS (reverse proxy), your API keys and tokens are transmitted in plaintext!** ⚠️

---

## Prerequisites

- **Domain name** pointing to your server (e.g., `api.yourdomain.com`)
- **Server** with root/sudo access (Ubuntu 20.04+, Debian, or similar)
- **Wayfinder** running on localhost (default port 3000)
- **Firewall** allowing ports 80 and 443

---

## Installation

### Ubuntu/Debian

```bash
# Update package list
sudo apt update

# Install Nginx
sudo apt install nginx -y

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Verify installation
nginx -v
# Expected output: nginx version: nginx/1.18.0 (Ubuntu)
```

### CentOS/RHEL

```bash
# Install Nginx
sudo yum install nginx -y

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### Verify Nginx is Running

```bash
# Check status
sudo systemctl status nginx

# Test from browser (should see Nginx welcome page)
curl http://localhost
```

---

## Basic Configuration

Create a basic reverse proxy configuration:

### 1. Create Nginx Configuration File

```bash
sudo nano /etc/nginx/sites-available/wayfinder
```

### 2. Add Basic Configuration

```nginx
# Basic HTTP configuration (no SSL yet)
server {
    listen 80;
    listen [::]:80;
    server_name api.yourdomain.com;

    # Logging
    access_log /var/log/nginx/wayfinder_access.log;
    error_log /var/log/nginx/wayfinder_error.log;

    # Proxy to Wayfinder
    location / {
        proxy_pass http://localhost:3000;

        # Preserve original request information
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

### 3. Enable Configuration

```bash
# Create symbolic link to enable site
sudo ln -s /etc/nginx/sites-available/wayfinder /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### 4. Test Basic Setup

```bash
curl http://api.yourdomain.com/health
# Should return: {"status":"healthy",...}
```

---

## SSL/TLS Setup with Let's Encrypt

### Method 1: Certbot (Recommended - Automated)

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Obtain and install certificate (interactive)
sudo certbot --nginx -d api.yourdomain.com

# Follow prompts:
# - Enter email for renewal notifications
# - Agree to terms of service
# - Choose whether to redirect HTTP to HTTPS (recommended: Yes)

# Certbot will automatically:
# 1. Obtain SSL certificate from Let's Encrypt
# 2. Update Nginx configuration
# 3. Set up auto-renewal
```

### Method 2: Manual Certbot (More Control)

```bash
# Obtain certificate only (don't modify Nginx config)
sudo certbot certonly --nginx -d api.yourdomain.com

# Certificates will be saved to:
# /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/api.yourdomain.com/privkey.pem
```

### Update Nginx Configuration for HTTPS

```bash
sudo nano /etc/nginx/sites-available/wayfinder
```

Replace contents with:

```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name api.yourdomain.com;

    # Redirect all HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.yourdomain.com;

    # SSL Certificate
    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    # SSL Configuration (secure defaults)
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # HSTS (strict transport security) - already set by Wayfinder
    # Uncomment if Wayfinder doesn't set it
    # add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    # Logging
    access_log /var/log/nginx/wayfinder_access.log;
    error_log /var/log/nginx/wayfinder_error.log;

    # Proxy to Wayfinder
    location / {
        proxy_pass http://localhost:3000;

        # Preserve original request information
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # Disable buffering for real-time responses
        proxy_buffering off;
    }
}
```

### Test and Reload

```bash
# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx

# Test HTTPS
curl https://api.yourdomain.com/health
```

### Auto-Renewal

Certbot sets up automatic renewal. Verify it works:

```bash
# Test renewal (dry run)
sudo certbot renew --dry-run

# Check renewal timer
sudo systemctl status certbot.timer
```

---

## Production-Ready Configuration

Enhanced configuration with security, performance, and reliability:

```nginx
# /etc/nginx/sites-available/wayfinder

# Rate limiting zones (application-level)
limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;

# Connection limits
limit_conn_zone $binary_remote_addr zone=addr:10m;

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name api.yourdomain.com;

    # Allow Let's Encrypt challenges
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # Redirect everything else to HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.yourdomain.com;

    # SSL Certificate
    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;

    # SSL Configuration (Mozilla Modern profile)
    ssl_protocols TLSv1.3 TLSv1.2;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';

    # SSL session resumption
    ssl_session_cache shared:SSL:50m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # OCSP stapling (online certificate status protocol)
    ssl_stapling on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /etc/letsencrypt/live/api.yourdomain.com/chain.pem;
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;

    # Security headers (Wayfinder sets most of these, but Nginx can add extras)
    # Note: Wayfinder already sets CSP, HSTS, X-Frame-Options, etc.
    # Only add headers here if they're missing or need to be overridden

    # Logging
    access_log /var/log/nginx/wayfinder_access.log combined buffer=32k flush=5s;
    error_log /var/log/nginx/wayfinder_error.log warn;

    # Client upload size limit
    client_max_body_size 10M;
    client_body_buffer_size 128k;

    # Timeouts
    client_header_timeout 30s;
    client_body_timeout 30s;
    send_timeout 30s;
    keepalive_timeout 65s;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types application/json text/plain text/css application/javascript text/xml application/xml application/xml+rss text/javascript;

    # Connection limits per IP
    limit_conn addr 20;

    # Health check endpoint (no rate limiting)
    location = /health {
        proxy_pass http://localhost:3000/health;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Short timeout for health checks
        proxy_connect_timeout 5s;
        proxy_send_timeout 5s;
        proxy_read_timeout 5s;

        access_log off; # Don't log health checks
    }

    # API endpoints (with rate limiting)
    location / {
        # Apply rate limiting (burst allows temporary spikes)
        limit_req zone=api burst=50 nodelay;
        limit_req_status 429;

        proxy_pass http://localhost:3000;

        # Preserve original request information
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;

        # Timeouts (adjust based on your LLM response times)
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 90s; # LLM routing can take time

        # Disable buffering for real-time responses
        proxy_buffering off;
        proxy_request_buffering off;

        # Connection settings
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    # Block common attack patterns
    location ~* \.(env|git|svn|htaccess|htpasswd)$ {
        deny all;
        return 404;
    }
}
```

### Apply Configuration

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Security Hardening

### 1. Firewall Configuration

```bash
# Allow only SSH, HTTP, and HTTPS
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Block direct access to Wayfinder port
# Wayfinder should only be accessible via Nginx
sudo ufw deny 3000/tcp
```

### 2. Nginx User Permissions

```bash
# Verify Nginx runs as www-data (not root)
ps aux | grep nginx

# Should show:
# www-data ... nginx: worker process
```

### 3. Hide Nginx Version

```bash
sudo nano /etc/nginx/nginx.conf
```

Add inside `http` block:

```nginx
http {
    server_tokens off; # Hide Nginx version
    # ... rest of config
}
```

### 4. Configure Fail2Ban (Block Brute Force)

```bash
# Install fail2ban
sudo apt install fail2ban -y

# Create Nginx jail
sudo nano /etc/fail2ban/jail.local
```

Add:

```ini
[nginx-limit-req]
enabled = true
filter = nginx-limit-req
action = iptables-multiport[name=ReqLimit, port="http,https", protocol=tcp]
logpath = /var/log/nginx/wayfinder_error.log
findtime = 600
maxretry = 10
bantime = 3600
```

```bash
# Restart fail2ban
sudo systemctl restart fail2ban

# Check status
sudo fail2ban-client status nginx-limit-req
```

---

## Load Balancing (Optional)

For high availability, run multiple Wayfinder instances:

### 1. Run Multiple Wayfinder Instances

```bash
# Instance 1 (port 3000)
PORT=3000 npm start &

# Instance 2 (port 3001)
PORT=3001 npm start &

# Instance 3 (port 3002)
PORT=3002 npm start &
```

### 2. Update Nginx Configuration

```nginx
# Define upstream backend
upstream wayfinder_backend {
    least_conn; # Load balancing method

    server localhost:3000 max_fails=3 fail_timeout=30s;
    server localhost:3001 max_fails=3 fail_timeout=30s;
    server localhost:3002 max_fails=3 fail_timeout=30s;

    keepalive 32; # Connection pooling
}

server {
    # ... SSL config ...

    location / {
        proxy_pass http://wayfinder_backend;

        # Same proxy headers as before
        proxy_set_header Host $host;
        # ... etc
    }
}
```

### 3. Use Docker Compose for Multiple Instances

```yaml
# docker-compose.yml
version: '3.8'
services:
  wayfinder-1:
    build: .
    ports:
      - "3000:3000"
  wayfinder-2:
    build: .
    ports:
      - "3001:3000"
  wayfinder-3:
    build: .
    ports:
      - "3002:3000"
```

---

## Monitoring and Logs

### View Logs

```bash
# Nginx access logs
sudo tail -f /var/log/nginx/wayfinder_access.log

# Nginx error logs
sudo tail -f /var/log/nginx/wayfinder_error.log

# Filter by status code
grep "429" /var/log/nginx/wayfinder_access.log

# Count requests per IP
awk '{print $1}' /var/log/nginx/wayfinder_access.log | sort | uniq -c | sort -rn | head -20
```

### Log Rotation

Nginx automatically rotates logs. Verify:

```bash
cat /etc/logrotate.d/nginx
```

### Nginx Status Endpoint

Enable Nginx status for monitoring:

```nginx
# Add to server block
location /nginx_status {
    stub_status on;
    access_log off;
    allow 127.0.0.1; # Only localhost
    deny all;
}
```

```bash
# Check status
curl http://localhost/nginx_status
```

---

## Troubleshooting

### Common Issues

#### 1. 502 Bad Gateway

**Cause**: Wayfinder not running or wrong port

```bash
# Check if Wayfinder is running
curl http://localhost:3000/health

# Check Nginx error log
sudo tail -f /var/log/nginx/wayfinder_error.log
```

#### 2. SSL Certificate Errors

**Cause**: Certificate not found or expired

```bash
# Check certificate expiration
sudo certbot certificates

# Renew certificate
sudo certbot renew
```

#### 3. 413 Request Entity Too Large

**Cause**: Request body exceeds `client_max_body_size`

```nginx
# Increase limit in server block
client_max_body_size 50M;
```

#### 4. Rate Limiting Issues

**Cause**: Nginx rate limits too strict

```bash
# Check Nginx error log for "limiting requests"
sudo grep "limiting requests" /var/log/nginx/wayfinder_error.log

# Adjust rate limits in config
limit_req_zone $binary_remote_addr zone=api:10m rate=100r/s;
```

### Debugging Commands

```bash
# Test Nginx configuration
sudo nginx -t

# Check Nginx status
sudo systemctl status nginx

# Reload Nginx (zero downtime)
sudo systemctl reload nginx

# Restart Nginx (brief downtime)
sudo systemctl restart nginx

# View Nginx configuration
nginx -T

# Check which config file is being used
nginx -V 2>&1 | grep "configure arguments"
```

---

## Alternative: Caddy

If you prefer a simpler setup, Caddy automatically handles SSL with Let's Encrypt:

### Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### Caddyfile Configuration

```caddyfile
# /etc/caddy/Caddyfile

api.yourdomain.com {
    reverse_proxy localhost:3000

    # Caddy handles SSL automatically!
    # No certificate configuration needed
}
```

### Start Caddy

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
```

**That's it!** Caddy automatically obtains and renews SSL certificates.

---

## Summary

✅ **Nginx provides:**
- SSL/TLS termination with Let's Encrypt
- Security headers (in addition to Wayfinder's)
- Rate limiting at the proxy level
- Load balancing for multiple instances
- Request/response compression
- Static file serving (if needed)

✅ **Wayfinder provides:**
- Application-level rate limiting (per token)
- Security headers (helmet.js)
- CORS configuration
- API key authentication
- LLM routing logic

**Both layers work together for defense in depth.**

---

## Quick Reference

| Task | Command |
|------|---------|
| Test config | `sudo nginx -t` |
| Reload Nginx | `sudo systemctl reload nginx` |
| Restart Nginx | `sudo systemctl restart nginx` |
| View access logs | `sudo tail -f /var/log/nginx/wayfinder_access.log` |
| View error logs | `sudo tail -f /var/log/nginx/wayfinder_error.log` |
| Renew SSL cert | `sudo certbot renew` |
| Check SSL status | `sudo certbot certificates` |

---

For questions or issues, refer to:
- [Nginx Documentation](https://nginx.org/en/docs/)
- [Certbot Documentation](https://certbot.eff.org/docs/)
- [Mozilla SSL Configuration Generator](https://ssl-config.mozilla.org/)
