<?php
/**
 * Auto-Deployment Webhook for cPanel & GitHub
 * Automatically pulls changes from GitHub and hot-reloads Node.js (Phusion Passenger)
 */

$security_token = 'ziarati_deploy_key_8492';

if (!isset($_GET['token']) || $_GET['token'] !== $security_token) {
    http_response_code(403);
    die('Access Denied: Invalid Security Token');
}

$repo_dir = '/home/donyagar/mashboard';
$output = [];

// 1. Pull latest commits from GitHub main branch
exec("cd $repo_dir && git fetch origin main 2>&1 && git reset --hard origin/main 2>&1", $output);

// 2. Trigger Phusion Passenger / cPanel Node.js live restart
exec("cd $repo_dir && mkdir -p tmp && touch tmp/restart.txt 2>&1", $output);

header('Content-Type: text/plain; charset=utf-8');
echo "=== نتیجه انتشار خودکار روی سی‌پنل ===\n";
echo "تاریخ: " . date('Y-m-d H:i:s') . "\n";
echo implode("\n", $output);
