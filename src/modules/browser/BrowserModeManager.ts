/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, mkdirSync, rmSync} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {Browser, Page} from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

import {logger} from '../../utils/logger.js';
import {
  StealthScripts2025,
  type StealthPreset,
} from '../stealth/StealthScripts2025.js';

export interface BrowserModeConfig {
  useStealthScripts?: boolean;
  stealthPreset?: StealthPreset;
  remoteDebuggingUrl?: string;
  autoLaunch?: boolean;
  browserPath?: string;
  remoteDebuggingPort?: number;
  waitForBrowserTimeoutMs?: number;
  waitForBrowserPollMs?: number;
  /** 自启动浏览器的独立 user-data-dir（Chrome 136+ 无独立目录会静默忽略
   *  --remote-debugging-port；缺省用 os.tmpdir()/jsreverser-mcp-profile-<port>） */
  userDataDir?: string;
}

interface SessionData {
  cookies?: any[];
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

type NormalizedBrowserModeConfig = Required<BrowserModeConfig>;

export class BrowserModeManager {
  private static detectedBrowsersCache: Array<{
    name: string;
    path: string;
  }> | null = null;
  private browser: Browser | null = null;
  private currentPage: Page | null = null;
  private readonly config: NormalizedBrowserModeConfig;
  private sessionData: SessionData = {};
  private browserProcess: ChildProcess | null = null;
  private autoLaunched = false;

  constructor(config: BrowserModeConfig = {}) {
    const port = config.remoteDebuggingPort ?? 9222;
    this.config = {
      useStealthScripts: config.useStealthScripts ?? true,
      stealthPreset: config.stealthPreset ?? 'windows-chrome',
      remoteDebuggingUrl:
        config.remoteDebuggingUrl ?? `http://127.0.0.1:${port}`,
      autoLaunch: config.autoLaunch ?? true,
      browserPath: config.browserPath ?? '',
      remoteDebuggingPort: port,
      waitForBrowserTimeoutMs: config.waitForBrowserTimeoutMs ?? 5000,
      waitForBrowserPollMs: config.waitForBrowserPollMs ?? 500,
      // 自启动独立 profile（Chrome 136+ 必需）；缺省 os.tmpdir()/jsreverser-mcp-profile-<port>
      userDataDir:
        config.userDataDir ??
        path.join(os.tmpdir(), `jsreverser-mcp-profile-${port}`),
    };
  }

  /**
   * 启动浏览器进程（带远程调试）
   */
  private async launchBrowserProcess(): Promise<void> {
    const browsers = this.detectAllBrowsers();

    if (browsers.length === 0) {
      throw new Error(
        'Cannot find browser executable. Please specify browserPath in config.\n' +
          'Supported browsers: Chrome, Edge',
      );
    }

    // 如果发现多个浏览器，使用第一个并记录
    if (browsers.length > 1) {
      logger.info(`🔍 Found ${browsers.length} browsers:`);
      browsers.forEach((b, i) => {
        logger.info(`  ${i + 1}. ${b.name}: ${b.path}`);
      });
      logger.info(`📌 Using: ${browsers[0].name}`);
      logger.info(`💡 To use a different browser, set browserPath in config`);
    }

    const selectedBrowser = browsers[0];
    logger.info(`🚀 Launching browser: ${selectedBrowser.path}`);
    logger.info(`🔌 Remote debugging port: ${this.config.remoteDebuggingPort}`);
    logger.info(`📁 User data dir: ${this.config.userDataDir}`);

    // Chrome 136+ 必须独立 user-data-dir 才会开 --remote-debugging-port，
    // 否则端口被静默忽略 → puppeteer.connect 永远失败（只能手动启浏览器）。
    // 确保目录存在（多次 launch 复用同目录；残留锁由 waitForBrowser 超时后再建）。
    mkdirSync(this.config.userDataDir, {recursive: true});

    const args = [
      `--remote-debugging-port=${this.config.remoteDebuggingPort}`,
      `--user-data-dir=${this.config.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];

    this.browserProcess = spawn(selectedBrowser.path, args, {
      detached: true,
      stdio: 'ignore',
    });

    this.browserProcess.unref();
    this.autoLaunched = true;

    // 等待浏览器启动
    await this.waitForBrowser(this.config.waitForBrowserTimeoutMs);
    logger.info('✅ Browser launched successfully');
  }

  /**
   * 等待浏览器就绪
   */
  private async waitForBrowser(timeout: number): Promise<void> {
    const startTime = Date.now();
    let lastError = '';
    while (Date.now() - startTime < timeout) {
      try {
        await puppeteer
          .connect({
            browserURL: this.config.remoteDebuggingUrl,
          })
          .then(browser => browser.disconnect());
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise(resolve =>
          setTimeout(resolve, this.config.waitForBrowserPollMs),
        );
      }
    }
    throw new Error(
      `Browser failed to start within ${timeout}ms at ${this.config.remoteDebuggingUrl}. Last connection error: ${lastError || 'unknown'}`,
    );
  }

  /**
   * 检测所有可用浏览器（支持任意盘符）
   */
  private detectAllBrowsers(): Array<{name: string; path: string}> {
    const foundBrowsers: Array<{name: string; path: string}> = [];

    // 如果配置中指定了路径，优先使用
    if (this.config.browserPath && existsSync(this.config.browserPath)) {
      foundBrowsers.push({
        name: 'Custom Browser',
        path: this.config.browserPath,
      });
      return foundBrowsers;
    }

    if (BrowserModeManager.detectedBrowsersCache) {
      return [...BrowserModeManager.detectedBrowsersCache];
    }

    const registerFound = (name: string, path: string): void => {
      if (!foundBrowsers.some(b => b.path === path)) {
        foundBrowsers.push({name, path});
      }
    };

    // 非 Windows 平台直接检测常见路径，避免无意义盘符扫描
    if (process.platform !== 'win32') {
      const unixCandidates =
        process.platform === 'darwin'
          ? [
              {
                name: 'Chrome (macOS)',
                path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              },
              {
                name: 'Edge (macOS)',
                path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
              },
            ]
          : [
              {name: 'Chrome (linux)', path: '/usr/bin/google-chrome'},
              {name: 'Chrome (linux)', path: '/usr/bin/google-chrome-stable'},
              {name: 'Chromium (linux)', path: '/usr/bin/chromium-browser'},
              {name: 'Chromium (linux)', path: '/usr/bin/chromium'},
              {name: 'Edge (linux)', path: '/usr/bin/microsoft-edge'},
            ];

      for (const candidate of unixCandidates) {
        if (existsSync(candidate.path)) {
          registerFound(candidate.name, candidate.path);
          logger.info(
            `🔍 Found browser: ${candidate.name} at ${candidate.path}`,
          );
        }
      }

      BrowserModeManager.detectedBrowsersCache = [...foundBrowsers];
      return foundBrowsers;
    }

    // 常见的浏览器安装路径模板
    const browserTemplates = [
      {
        name: 'Chrome',
        paths: [
          'Google\\Chrome\\Application\\chrome.exe',
          'Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ],
      },
      {
        name: 'Edge',
        paths: [
          'Microsoft\\Edge\\Application\\msedge.exe',
          'Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ],
      },
    ];

    // 检测所有可能的盘符（A-Z）
    const driveLetters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

    for (const drive of driveLetters) {
      for (const template of browserTemplates) {
        for (const browserPath of template.paths) {
          const fullPath = `${drive}:\\${browserPath}`;
          if (existsSync(fullPath)) {
            registerFound(`${template.name} (${drive}:)`, fullPath);
            logger.info(`🔍 Found browser: ${template.name} at ${fullPath}`);
          }
        }
      }
    }

    BrowserModeManager.detectedBrowsersCache = [...foundBrowsers];
    return foundBrowsers;
  }

  async launch(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      logger.info('🔁 Browser already connected, reusing existing session.');
      return this.browser;
    }

    logger.info(
      `🌐 Connecting to browser at ${this.config.remoteDebuggingUrl}...`,
    );

    try {
      this.browser = await puppeteer.connect({
        browserURL: this.config.remoteDebuggingUrl,
      });

      logger.info('✅ Successfully connected to browser');
      return this.browser;
    } catch (error) {
      logger.warn('⚠️ Failed to connect to existing browser:', error);

      if (this.config.autoLaunch) {
        logger.info('🔄 Attempting to auto-launch browser...');
        try {
          await this.launchBrowserProcess();

          this.browser = await puppeteer.connect({
            browserURL: this.config.remoteDebuggingUrl,
          });

          logger.info('✅ Successfully connected to auto-launched browser');
          return this.browser;
        } catch (launchError) {
          logger.error('❌ Failed to auto-launch browser:', launchError);
          throw new Error(
            `Failed to connect and auto-launch browser. ` +
              `Please manually start your browser with: chrome.exe --remote-debugging-port=${this.config.remoteDebuggingPort}`,
          );
        }
      } else {
        throw new Error(
          `Failed to connect to browser at ${this.config.remoteDebuggingUrl}. ` +
            `Please ensure your browser is running with remote debugging enabled. ` +
            `Example: chrome.exe --remote-debugging-port=${this.config.remoteDebuggingPort}`,
        );
      }
    }
  }

  async newPage(): Promise<Page> {
    if (!this.browser) {
      await this.launch();
    }

    const page = await this.browser!.newPage();
    this.currentPage = page;
    page.on('close', () => {
      if (this.currentPage === page) {
        this.currentPage = null;
      }
    });

    await page.setCacheEnabled(true);
    await page.setBypassCSP(true);
    await page.setJavaScriptEnabled(true);

    if (this.config.useStealthScripts) {
      // 使用平台预设注入反检测脚本（默认 windows-chrome）
      const preset = this.config.stealthPreset ?? 'windows-chrome';
      await StealthScripts2025.injectAll(page, {preset});
    }

    await this.injectAntiDetectionScripts(page);

    if (this.sessionData.cookies?.length) {
      await page.setCookie(...this.sessionData.cookies);
    }

    return page;
  }

  async goto(url: string, page?: Page): Promise<Page> {
    const targetPage = page ?? this.currentPage;
    if (!targetPage) {
      throw new Error('No page available. Call newPage() first.');
    }

    logger.info(`🌐 Navigating to ${url}`);
    await targetPage.goto(url, {waitUntil: 'networkidle2'});

    return targetPage;
  }

  private async injectAntiDetectionScripts(page: Page): Promise<void> {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {get: () => undefined});

      (window as any).chrome = {
        runtime: {
          connect: () => undefined,
          sendMessage: () => undefined,
          onMessage: {
            addListener: () => undefined,
            removeListener: () => undefined,
          },
        },
      };

      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          {
            0: {
              type: 'application/pdf',
              suffixes: 'pdf',
              description: 'Portable Document Format',
            },
            description: 'Portable Document Format',
            filename: 'internal-pdf-viewer',
            length: 1,
            name: 'Chrome PDF Plugin',
          },
        ],
      });

      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({
              state: (Notification as any).permission,
            } as PermissionStatus)
          : originalQuery(parameters);

      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      });
    });

    logger.info('🛡️ Anti-detection scripts injected');
  }

  async close(): Promise<void> {
    if (!this.browser) {
      return;
    }

    try {
      await this.browser.disconnect();
      logger.info('🔌 Disconnected from browser.');
    } catch (error) {
      logger.warn('Failed to disconnect from browser', error);
    } finally {
      this.browser = null;
      this.currentPage = null;
    }

    // 如果是自动启动的浏览器，终止进程（Windows 用 taskkill /T /F 杀整棵进程树，
    // SIGTERM 只杀主进程——渲染器子进程会残留 + 锁住 profile 目录）
    const wasAutoLaunched = this.autoLaunched;
    if (
      wasAutoLaunched &&
      this.browserProcess &&
      !this.browserProcess.killed
    ) {
      try {
        if (process.platform === 'win32') {
          const {execFileSync} = await import('node:child_process');
          execFileSync(
            'taskkill', ['/PID', String(this.browserProcess.pid), '/T', '/F'],
            {stdio: 'ignore', windowsHide: true},
          );
        } else {
          this.browserProcess.kill('SIGTERM');
        }
        this.browserProcess = null;
        this.autoLaunched = false;
        logger.info('🔒 Auto-launched browser process tree terminated.');
      } catch (error) {
        logger.warn('Failed to terminate browser process', error);
      }
    }

    // 自启动浏览器结束后清理独立 profile（仅 autoLaunch 的浏览器清理，
    // 外部浏览器 profile 由外部管理）。taskkill /T /F 是同步的 → 直接删。
    if (wasAutoLaunched && this.config.userDataDir) {
      try {
        // Windows taskkill /F 已强杀整树，等几个 tick 让文件句柄释放
        setTimeout(() => {
          try {
            rmSync(this.config.userDataDir, {recursive: true, force: true});
            logger.info('🧹 Auto-launch user-data-dir cleaned.');
          } catch (error) {
            logger.warn('Failed to clean user-data-dir', error);
          }
        }, 300);
      } catch (error) {
        logger.warn('Failed to schedule user-data-dir cleanup', error);
      }
    }
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  getCurrentPage(): Page | null {
    return this.currentPage;
  }

  setCurrentPage(page: Page | null): void {
    this.currentPage = page;
  }
}
