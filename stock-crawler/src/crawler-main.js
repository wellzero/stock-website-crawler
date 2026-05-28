import ConfigManager from './config-manager.js';
import LinkManager from './link-manager.js';
import BrowserManager from './browser-manager.js';
import LoginHandler from './login-handler.js';
import LinkFinder from './link-finder.js';
import PageParser from './page-parser.js';
import MarkdownGenerator from './parsers/markdown-generator.js';
import Logger from './logger.js';
import StatsTracker from './stats-tracker.js';

class CrawlerMain {
  constructor() {
    this.config = null;
    this.linkManager = null;
    this.browserManager = null;
    this.loginHandler = null;
    this.linkFinder = null;
    this.pageParser = null;
    this.markdownGenerator = null;
    this.logger = null;
    this.statsTracker = null;
    this.isLoggedIn = false;
  }

  /**
   * Initialize crawler with configuration
   * @param {string} configPath - Path to configuration file
   */
  async initialize(configPath) {
    // Load configuration first
    const configManager = new ConfigManager();
    this.config = configManager.loadConfig(configPath);
    
    // Setup project directory structure
    // output/project-name/
    this.projectDir = `${this.config.output.directory}/${this.config.name}`;
    this.logsDir = `${this.projectDir}/logs`;
    this.linksFile = `${this.projectDir}/links.txt`;
    
    // Create directories if they don't exist
    const fs = await import('fs');
    if (!fs.existsSync(this.projectDir)) {
      fs.mkdirSync(this.projectDir, { recursive: true });
    }
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
    
    // Initialize logger with project-specific log directory
    this.logger = new Logger(this.logsDir);
    this.statsTracker = new StatsTracker();
    
    // Create pages directory with timestamp suffix matching log file
    const timestamp = this.logger.getTimestamp();
    this.pagesDir = `${this.projectDir}/pages-${timestamp}`;
    if (!fs.existsSync(this.pagesDir)) {
      fs.mkdirSync(this.pagesDir, { recursive: true });
    }
    
    this.logger.info(`Loaded configuration: ${this.config.name}`);

    // Initialize link manager
    this.linkManager = new LinkManager();
    this.linkManager.loadLinks(this.linksFile);
    this.logger.info(`Loaded ${this.linkManager.links.length} links from ${this.linksFile}`);
    
    // If no links loaded, initialize with seed URLs
    if (this.linkManager.links.length === 0 && this.config.seedUrls && this.config.seedUrls.length > 0) {
      this.logger.info(`Initializing with ${this.config.seedUrls.length} seed URLs`);
      this.config.seedUrls.forEach(url => {
        try {
          this.linkManager.addLink(url, 'pending');
        } catch (error) {
          this.logger.error(`Failed to add seed URL ${url}: ${error.message}`);
        }
      });
      this.linkManager.saveLinks(this.linksFile, this.linkManager.links);
    }

    // Initialize other modules
    this.browserManager = new BrowserManager();
    this.loginHandler = new LoginHandler();
    this.linkFinder = new LinkFinder();
    this.pageParser = new PageParser();
    this.markdownGenerator = new MarkdownGenerator();

    this.logger.info(`Project directory: ${this.projectDir}`);
    this.logger.info(`Pages directory: ${this.pagesDir}`);
    this.logger.info(`Logs directory: ${this.logsDir}`);
    this.logger.info('Crawler initialized successfully');
  }

  /**
   * Start crawling process
   */
  async start() {
    try {
      this.logger.info('Starting crawler...');
      this.statsTracker.start();

      // Launch browser
      await this.browserManager.launch({
        headless: this.config.crawler.headless,
        timeout: this.config.crawler.timeout,
        userDataDir: this.config.crawler.userDataDir, // Use Chrome user data directory if provided
        ignoreHTTPSErrors: this.config.crawler.ignoreHTTPSErrors === true,
        fetchMethod: this.config.crawler.fetchMethod || 'playwright'
      });
      this.logger.info(`Browser launched (headless: ${this.config.crawler.headless}, fetchMethod: ${this.config.crawler.fetchMethod || 'playwright'})`);

      // Attempt login at the start if required
      if (this.config.login.required) {
        this.logger.info('Login is required, attempting to login at start...');
        const loginSuccess = await this.attemptLogin();
        if (loginSuccess) {
          this.logger.info('Login successful at start');
          this.isLoggedIn = true;
        } else {
          this.logger.warn('Login failed at start, will retry on individual pages if needed');
        }
      }

      // Get batch size from config (default 20)
      const batchSize = this.config.crawler.batchSize || 20;
      
      // Start with seed URLs - only process when still unfetched/failed
      let linksToProcess = [];
      
      if (this.config.seedUrls && this.config.seedUrls.length > 0) {
        for (const seedUrl of this.config.seedUrls) {
          const existingLink = this.linkManager.links.find(l => l.url === seedUrl);
          if (!existingLink) {
            // Seed URL not in list, add it
            this.linkManager.addLink(seedUrl, 'unfetched');
            linksToProcess.push({ url: seedUrl, status: 'unfetched' });
          } else if (existingLink.status !== 'fetched' && existingLink.status !== 'fetching') {
            // Seed URL exists and still pending, prioritize it
            linksToProcess.push(existingLink);
          }
        }
      }
      
      // Then get unfetched links from links.txt
      const unfetchedLinks = this.linkManager.getUnfetchedLinks();
      
      // Sort unfetched links by priority:
      // 1. Path depth (fewer slashes = higher priority, usually level 1 or 2 pages)
      // 2. URLs with numeric path segments (e.g., /product/123, /2024/report)
      // 3. URLs without query parameters (no & or =)
      // 4. URL length (shorter first)
      const sortedUnfetchedLinks = unfetchedLinks.sort((a, b) => {
        // First priority: URL length (shorter first)
        const aLength = a.url.length;
        const bLength = b.url.length;
        
        if (aLength !== bLength) {
          return aLength - bLength; // Shorter URLs = higher priority
        }
        
        // Second priority: Path depth (count slashes in path)
        // Fewer slashes = higher level page = more important
        const getPathDepth = (url) => {
          try {
            const urlObj = new URL(url);
            // Count slashes in pathname (excluding the domain)
            return (urlObj.pathname.match(/\//g) || []).length;
          } catch {
            return (url.match(/\//g) || []).length;
          }
        };
        
        const aDepth = getPathDepth(a.url);
        const bDepth = getPathDepth(b.url);
        
        if (aDepth !== bDepth) {
          return aDepth - bDepth; // Fewer slashes = higher priority
        }
        
        // Third priority: URLs with numeric path segments
        const aHasNumericSegment = /\/\d+(?:\/|$)/.test(a.url);
        const bHasNumericSegment = /\/\d+(?:\/|$)/.test(b.url);
        
        if (aHasNumericSegment !== bHasNumericSegment) {
          return aHasNumericSegment ? -1 : 1;
        }
        
        // Fourth priority: URLs without query parameters
        const aHasParams = a.url.includes('?') || a.url.includes('&') || a.url.includes('=');
        const bHasParams = b.url.includes('?') || b.url.includes('&') || b.url.includes('=');
        
        if (aHasParams !== bHasParams) {
          return aHasParams ? 1 : -1;
        }
        
        // All criteria are equal, maintain original order
        return 0;
      });
      
      // Add unfetched links to processing list (after seed URLs)
      for (const link of sortedUnfetchedLinks) {
        // Skip if already in processing list (e.g., it's a seed URL)
        if (!linksToProcess.find(l => l.url === link.url)) {
          linksToProcess.push(link);
        }
      }
      
      // Limit to batch size
      linksToProcess = linksToProcess.slice(0, batchSize);
      
      this.statsTracker.setTotalUrls(this.linkManager.links.length);
      
      const seedUrlsPending = linksToProcess.filter(link =>
        (this.config.seedUrls || []).includes(link.url)
      ).length;

      this.logger.info(`Found ${unfetchedLinks.length} unfetched URLs (including ${seedUrlsPending} pending seed URLs), processing ${linksToProcess.length} URLs in this batch`);

      if (linksToProcess.length === 0) {
        this.logger.info('No URLs to process in this batch. Crawling is up to date.');
      }

      // Process each URL, including newly discovered links within the same batch
      let processedCount = 0;
      while (processedCount < linksToProcess.length) {
        const link = linksToProcess[processedCount];
        this.logProgress(processedCount + 1, linksToProcess.length);

        // Mark as fetching
        this.linkManager.updateLinkStatus(link.url, 'fetching');
        this.linkManager.saveLinks(this.linksFile, this.linkManager.links);

        const success = await this.processUrl(link.url);

        if (success) {
          this.statsTracker.incrementCrawled();
        } else {
          this.statsTracker.incrementFailed();
        }

        // After processing, check for newly discovered unfetched links
        // and add them to the batch (up to batchSize limit)
        const currentUnfetched = this.linkManager.getUnfetchedLinks();
        const newlyAdded = currentUnfetched.filter(
          l => !linksToProcess.find(lp => lp.url === l.url)
        );
        if (newlyAdded.length > 0 && linksToProcess.length < batchSize) {
          const slotsRemaining = batchSize - linksToProcess.length;
          const toAdd = newlyAdded.slice(0, slotsRemaining);
          linksToProcess.push(...toAdd);
        }

        processedCount++;

        // Wait between requests
        if (processedCount < linksToProcess.length) {
          await this.sleep(this.config.crawler.waitBetweenRequests);
        }
      }

      // Close browser
      await this.browserManager.close();
      this.logger.info('Browser closed');

      // Generate and display stats
      this.statsTracker.end();
      const stats = this.generateStats();
      this.displayStats(stats);

      // Show remaining unfetched links
      const remainingUnfetched = this.linkManager.getUnfetchedLinks().length;
      if (remainingUnfetched > 0) {
        this.logger.info(`${remainingUnfetched} unfetched URLs remaining. Run again to continue crawling.`);
      }

      this.logger.info('Crawling completed successfully');
    } catch (error) {
      this.logger.error('Fatal error during crawling', error);
      throw error;
    }
  }

  /**
   * Attempt to login at the start of crawling
   * Tries multiple strategies to find and complete login
   * @returns {Promise<boolean>} Success status
   */
  async attemptLogin() {
    let page = null;
    try {
      page = await this.browserManager.newPage();
      
      // Strategy 1: Try the configured login URL or first seed URL
      const targetUrl = this.config.login.loginUrl || (this.config.seedUrls && this.config.seedUrls.length > 0 ? this.config.seedUrls[0] : null);
      if (!targetUrl) {
        this.logger.warn('No login URL or seed URLs available for login attempt');
        if (page) {
          try {
            if (!page.isClosed()) {
              await page.close();
            }
          } catch (e) {}
        }
        return false;
      }
      this.logger.info(`Strategy 1: Visiting target URL: ${targetUrl}`);
      
      await this.browserManager.goto(page, targetUrl, this.config.crawler.timeout, { forcePlaywright: true });
      await page.waitForTimeout(3000); // Wait for any redirects or dynamic content
      
      // Check current URL - might have been redirected to login page
      const currentUrl = page.url();
      this.logger.info(`Current URL after navigation: ${currentUrl}`);
      
      // Check if we're on a login page or if there's a password field
      const needsLogin = currentUrl.includes('login') || (await page.locator('input[type="password"]').count()) > 0;
      
      if (!needsLogin) {
        // Try to find and click login link
        this.logger.info('Not on login page, looking for login link...');
        const loginLink = page.locator('text=登录').first();
        if (await loginLink.count() > 0) {
          this.logger.info('Found login link, clicking...');
          await loginLink.click();
          await page.waitForTimeout(2000);
        }
      }
      
      // Now check if we need to login
      const hasPasswordField = await page.locator('input[type="password"]').count() > 0;
      
      if (hasPasswordField) {
        this.logger.info('Login form detected, attempting to log in...');
        const success = await this.loginHandler.login(page, {
          username: this.config.login.username,
          password: this.config.login.password
        });

        if (success) {
          this.logger.info('Login successful');
          await page.waitForTimeout(2000);
          await page.close();
          return true;
        } else {
          this.logger.warn('Login failed on target page');
        }
      } else {
        this.logger.info('No login form found on target page, will try seed URL');
        // Don't return true here - user may not be logged in
        // Fall through to Strategy 2
      }

      // Strategy 2: Try to find login link on the main page
      this.logger.info('Strategy 2: Looking for login link on main page');
      const mainUrl = this.config.seedUrls && this.config.seedUrls.length > 0 ? this.config.seedUrls[0] : null;
      if (!mainUrl) {
        this.logger.warn('No seed URLs available for Strategy 2');
        if (page) {
          try {
            if (!page.isClosed()) {
              await page.close();
            }
          } catch (e) {}
        }
        return false;
      }
      
      // Reuse the same page if still open, otherwise create new one
      let pageClosed = false;
      try {
        pageClosed = page ? page.isClosed() : true;
      } catch (e) {
        pageClosed = true;
      }
      if (!page || pageClosed) {
        page = await this.browserManager.newPage();
      }
      
      await this.browserManager.goto(page, mainUrl, this.config.crawler.timeout, { forcePlaywright: true });
      await page.waitForTimeout(2000);
      
      // Check if already needs login on this page
      const needsLoginNow = await this.loginHandler.needsLogin(page);
      if (needsLoginNow) {
        this.logger.info('Login form found on main page');
        const success = await this.loginHandler.login(page, {
          username: this.config.login.username,
          password: this.config.login.password
        });
        
        if (success) {
          this.logger.info('Login successful');
          await page.waitForTimeout(2000);
          await page.close();
          return true;
        }
      }
      
      // Look for login links using locator API
      const loginLinkSelectors = [
        'text=登录',
        'text=登錄',
        'text=Login',
        'text=Sign in',
        'a[href*="login"]',
        'a[href*="signin"]',
        'button:has-text("登录")',
        'button:has-text("登錄")'
      ];
      
      for (const selector of loginLinkSelectors) {
        try {
          const loginLink = page.locator(selector).first();
          const count = await loginLink.count();
          if (count > 0) {
            this.logger.info(`Found login link with selector: ${selector}`);
            await loginLink.click();
            await page.waitForTimeout(2000);
            
            const needsLogin = await this.loginHandler.needsLogin(page);
            if (needsLogin) {
              this.logger.info('Login form appeared after clicking link');
              const success = await this.loginHandler.login(page, {
                username: this.config.login.username,
                password: this.config.login.password
              });
              
              if (success) {
                this.logger.info('Login successful');
                await page.waitForTimeout(2000);
                await page.close();
                return true;
              }
            }
          }
        } catch (error) {
          // Continue to next selector
          continue;
        }
      }
      
      // Strategy 3: Try common login URL patterns
      this.logger.info('Strategy 3: Trying common login URL patterns');
      const baseUrl = new URL(mainUrl).origin;
      const commonLoginPaths = [
        '/login',
        '/signin',
        '/user/login',
        '/account/login',
        '/auth/login',
        '/member/login'
      ];
      
      for (const path of commonLoginPaths) {
        try {
          const loginUrl = baseUrl + path;
          this.logger.info(`Trying: ${loginUrl}`);
          
          let pageClosed2 = false;
          try {
            pageClosed2 = page ? page.isClosed() : true;
          } catch (e) {
            pageClosed2 = true;
          }
          if (!page || pageClosed2) {
            page = await this.browserManager.newPage();
          }
          
          await this.browserManager.goto(page, loginUrl, this.config.crawler.timeout, { forcePlaywright: true });
          await page.waitForTimeout(2000);
          
          const needsLogin = await this.loginHandler.needsLogin(page);
          if (needsLogin) {
            this.logger.info(`Found login form at: ${loginUrl}`);
            const success = await this.loginHandler.login(page, {
              username: this.config.login.username,
              password: this.config.login.password
            });
            
            if (success) {
              this.logger.info('Login successful');
              await page.waitForTimeout(2000);
              await page.close();
              return true;
            }
          }
        } catch (error) {
          // Continue to next path
          continue;
        }
      }
      
      if (page) {
        try {
          if (!page.isClosed()) {
            await page.close();
          }
        } catch (e) {}
      }
      this.logger.warn('All login strategies failed');
      return false;
    } catch (error) {
      this.logger.error('Error during login attempt', error);
      if (page) {
        try {
          if (!page.isClosed()) {
            await page.close();
          }
        } catch (e) {}
      }
      return false;
    }
  }

  /**
   * Process a single URL
   * @param {string} url - URL to process
   * @returns {boolean} Success status
   */
  async processUrl(url) {
    const maxRetries = this.config.crawler.maxRetries || 3;

    try {
      this.logger.info(`Processing: ${url}`);

      // Create new page
      const page = await this.browserManager.newPage();

      // 如果 parser 有 beforeLoad 钩子，在导航前调用（用于设置 API 拦截器等）
      try {
        const preParser = await this.pageParser.parserManager.selectParser(url);
        if (preParser && typeof preParser.beforeLoad === 'function') {
          await preParser.beforeLoad({ page, url, options: {}, data: {} });
        }
      } catch (e) {
        // ignore pre-navigation hook errors
      }

      // Navigate to URL
      await this.browserManager.goto(page, url, this.config.crawler.timeout);
      this.logger.info(`Loaded: ${url}`);

      // Handle login if needed
      if (this.config.login.required && !this.isLoggedIn) {
        const needsLogin = await this.loginHandler.needsLogin(page);
        
        if (needsLogin) {
          this.logger.info('Login required on this page, attempting to log in...');
          const loginSuccess = await this.loginHandler.login(page, {
            username: this.config.login.username,
            password: this.config.login.password
          });

          if (loginSuccess) {
            this.logger.info('Login successful');
            this.isLoggedIn = true;
            
            // Navigate to original URL after login
            if (page.url() !== url) {
              await this.browserManager.goto(page, url, this.config.crawler.timeout);
            }
          } else {
            this.logger.warn('Login failed on this page');
          }
        }
      }

      // Wait for page to load
      await this.browserManager.waitForLoad(page, this.config.crawler.timeout);

      // Expand collapsible content (only useful if JS is running)
      if (this.config.crawler.fetchMethod !== 'request') {
        await this.linkFinder.expandCollapsibles(page);
      }

      // Check if the parser supports custom link discovery
      const parser = await this.pageParser.parserManager.selectParser(url);
      let newLinks = [];

      if (parser.supportsLinkDiscovery && parser.supportsLinkDiscovery()) {
        this.logger.info('Using parser-based link discovery');
        newLinks = await parser.discoverLinks(page, this.config.urlRules);
      } else {
        // Standard link extraction
        newLinks = await this.linkFinder.extractLinks(page, this.config.urlRules, {
          fetchMethod: this.config.crawler.fetchMethod
        });
      }

      if (newLinks.length > 0) {
        this.logger.info(`Found ${newLinks.length} new links`);
        newLinks.forEach(link => {
          this.linkManager.addLink(link, 'unfetched');
        });
        this.statsTracker.addNewLinks(newLinks.length);
        this.linkManager.saveLinks(this.linksFile, this.linkManager.links);
      }

      // Parse page content with streaming support
      let filename = null;
      let filepath = null;
      let isFirstChunk = true;
      let pageTitle = null;
      
      // 先提取页面标题以确定文件名
      pageTitle = await page.evaluate(() => {
        return document.title || '';
      });
      
      // 生成文件名和路径
      const fs = await import('fs');
      const crypto = await import('crypto');
      
      filename = this.markdownGenerator.safeFilename(pageTitle || 'untitled', url);
      filepath = `${this.pagesDir}/${filename}.md`;
      
      // 检查文件是否存在，如果存在则添加hash
      if (fs.existsSync(filepath)) {
        const urlHash = crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
        filename = `${filename}_${urlHash}`;
        filepath = `${this.pagesDir}/${filename}.md`;
      }
      
      let writeLock = Promise.resolve();
      const onDataChunk = async (chunk) => {
        writeLock = writeLock.then(async () => {
          try {
            const fs = await import('fs');
            
            // 初始化文件（第一次）
            if (isFirstChunk) {
              // 写入文件头
              const header = `# ${pageTitle || 'Untitled'}\n\n## 源URL\n\n${url}\n\n`;
              fs.writeFileSync(filepath, header, 'utf-8');
              isFirstChunk = false;
            }
          
          // 追加数据块
          if (chunk.type === 'table') {
            if (chunk.isFirstPage) {
              // 新表格开始
              let tableContent = '\n';

              // 输出表格前的标题和说明文字
              if (chunk.precedingContent && chunk.precedingContent.length > 0) {
                chunk.precedingContent.forEach(item => {
                  if (item.type === 'heading') {
                    tableContent += `${'#'.repeat(item.level)} ${item.content}\n\n`;
                  } else if (item.type === 'paragraph') {
                    tableContent += `${item.content}\n\n`;
                  }
                });
              }

              tableContent += `## 表格 ${chunk.tableIndex + 1}\n\n`;

              // 表头
              if (chunk.headers && chunk.headers.length > 0) {
                tableContent += '| ' + chunk.headers.join(' | ') + ' |\n';
                tableContent += '| ' + chunk.headers.map(() => '---').join(' | ') + ' |\n';
              }

              // 数据行
              if (chunk.rows && chunk.rows.length > 0) {
                chunk.rows.forEach(row => {
                  tableContent += '| ' + row.join(' | ') + ' |\n';
                });
              }

              fs.appendFileSync(filepath, tableContent, 'utf-8');
              this.logger.info(`Appended table ${chunk.tableIndex + 1}, page ${chunk.page}`);
            } else if (!chunk.isLastPage && chunk.rows && chunk.rows.length > 0) {
              // 追加数据行
              let rowsContent = '';
              chunk.rows.forEach(row => {
                rowsContent += '| ' + row.join(' | ') + ' |\n';
              });
              fs.appendFileSync(filepath, rowsContent, 'utf-8');
              this.logger.info(`Appended ${chunk.rows.length} rows to table ${chunk.tableIndex + 1}, page ${chunk.page}`);
            }
          } else if (chunk.type === 'table-new') {
            // 结构变化，新表格
            let tableContent = `\n## 表格 ${chunk.tableIndex + 1} (结构变化)\n\n`;
            
            if (chunk.headers && chunk.headers.length > 0) {
              tableContent += '| ' + chunk.headers.join(' | ') + ' |\n';
              tableContent += '| ' + chunk.headers.map(() => '---').join(' | ') + ' |\n';
            }
            
            if (chunk.rows && chunk.rows.length > 0) {
              chunk.rows.forEach(row => {
                tableContent += '| ' + row.join(' | ') + ' |\n';
              });
            }
            
            fs.appendFileSync(filepath, tableContent, 'utf-8');
            this.logger.info(`Started new table ${chunk.tableIndex + 1} due to structure change`);
          } else if (chunk.type === 'tab') {
            // Tab页内容（只有数据变化时才会收到）
            let tabContent = `\n## Tab页: ${chunk.name}\n\n`;
            
            // 添加段落
            if (chunk.data.paragraphs && chunk.data.paragraphs.length > 0) {
              chunk.data.paragraphs.forEach(p => {
                if (p.trim()) {
                  tabContent += p + '\n\n';
                }
              });
            }
            
            // 添加列表
            if (chunk.data.lists && chunk.data.lists.length > 0) {
              chunk.data.lists.forEach(list => {
                list.items.forEach((item, i) => {
                  if (list.type === 'ol') {
                    tabContent += `${i + 1}. ${item}\n`;
                  } else {
                    tabContent += `- ${item}\n`;
                  }
                });
                tabContent += '\n';
              });
            }
            
            // 添加表格
            if (chunk.data.tables && chunk.data.tables.length > 0) {
              chunk.data.tables.forEach(table => {
                if (table.headers && table.headers.length > 0) {
                  tabContent += '| ' + table.headers.join(' | ') + ' |\n';
                  tabContent += '| ' + table.headers.map(() => '---').join(' | ') + ' |\n';
                  
                  if (table.rows && table.rows.length > 0) {
                    table.rows.forEach(row => {
                      tabContent += '| ' + row.join(' | ') + ' |\n';
                    });
                  }
                  tabContent += '\n';
                }
              });
            }
            
            // 添加代码块
            if (chunk.data.codeBlocks && chunk.data.codeBlocks.length > 0) {
              chunk.data.codeBlocks.forEach(block => {
                tabContent += `\`\`\`${block.language}
${block.code}
\`\`\`

`;
              });
            }
            
            fs.appendFileSync(filepath, tabContent, 'utf-8');
            this.logger.info(`Appended tab content: ${chunk.name}`);
          } else if (chunk.type === 'dropdown-option') {
            // 下拉框选项内容（只有数据变化时才会收到）
            let dropdownContent = `\n## 下拉框: ${chunk.dropdown} - 选项: ${chunk.option}\n\n`;
            
            // 添加段落
            if (chunk.data.paragraphs && chunk.data.paragraphs.length > 0) {
              chunk.data.paragraphs.forEach(p => {
                if (p.trim()) {
                  dropdownContent += p + '\n\n';
                }
              });
            }
            
            // 添加列表
            if (chunk.data.lists && chunk.data.lists.length > 0) {
              chunk.data.lists.forEach(list => {
                list.items.forEach((item, i) => {
                  if (list.type === 'ol') {
                    dropdownContent += `${i + 1}. ${item}\n`;
                  } else {
                    dropdownContent += `- ${item}\n`;
                  }
                });
                dropdownContent += '\n';
              });
            }
            
            // 添加表格
            if (chunk.data.tables && chunk.data.tables.length > 0) {
              chunk.data.tables.forEach(table => {
                if (table.headers && table.headers.length > 0) {
                  dropdownContent += '| ' + table.headers.join(' | ') + ' |\n';
                  dropdownContent += '| ' + table.headers.map(() => '---').join(' | ') + ' |\n';
                  
                  if (table.rows && table.rows.length > 0) {
                    table.rows.forEach(row => {
                      dropdownContent += '| ' + row.join(' | ') + ' |\n';
                    });
                  }
                  dropdownContent += '\n';
                }
              });
            }
            
            // 添加代码块
            if (chunk.data.codeBlocks && chunk.data.codeBlocks.length > 0) {
              chunk.data.codeBlocks.forEach(block => {
                dropdownContent += `\`\`\`${block.language}
${block.code}
\`\`\`

`;
              });
            }
            
            fs.appendFileSync(filepath, dropdownContent, 'utf-8');
            this.logger.info(`Appended dropdown option: ${chunk.dropdown} - ${chunk.option}`);
          } else if (chunk.type === 'date-filter') {
            // 日期筛选内容
            let dateFilterContent = `\n## 时间筛选: ${chunk.range}\n\n`;
            dateFilterContent += `时间范围: ${chunk.startDate} 至 ${chunk.endDate}\n\n`;
            
            // 添加表格数据
            if (chunk.tables && chunk.tables.length > 0) {
              chunk.tables.forEach((table, idx) => {
                dateFilterContent += `### 表格 ${idx + 1}\n\n`;
                
                if (table.headers && table.headers.length > 0) {
                  dateFilterContent += '| ' + table.headers.join(' | ') + ' |\n';
                  dateFilterContent += '| ' + table.headers.map(() => '---').join(' | ') + ' |\n';
                  
                  if (table.rows && table.rows.length > 0) {
                    table.rows.forEach(row => {
                      dateFilterContent += '| ' + row.join(' | ') + ' |\n';
                    });
                  }
                  dateFilterContent += '\n';
                }
              });
            }
            
            fs.appendFileSync(filepath, dateFilterContent, 'utf-8');
            this.logger.info(`Appended date filter data: ${chunk.range}`);
            }
          } catch (error) {
            this.logger.error(`Failed to write data chunk: ${error.message}`);
          }
        }).catch(err => this.logger.error(`Write lock error: ${err.message}`));
        await writeLock;
      };
      
      const pageData = await this.pageParser.parsePage(page, url, { 
        onDataChunk,
        filepath,
        pagesDir: this.pagesDir,
        extractionConfig: this.config.extraction || {}
      });
      this.logger.info(`Parsed page: ${pageData.title || 'Untitled'}`);

      // 如果没有使用流式写入（没有分页数据），使用传统方式
      if (isFirstChunk && !pageData.skipDefaultMarkdownOutput) {
        const markdown = this.markdownGenerator.generate(pageData);
        // 优先使用 parser 建议的文件名（如基于 URL 路径的文件名）
        if (pageData.suggestedFilename) {
          filename = pageData.suggestedFilename;
        } else {
          filename = this.markdownGenerator.safeFilename(pageData.title || 'untitled', url);
        }
        
        const fs = await import('fs');
        filepath = `${this.pagesDir}/${filename}.md`;
        if (fs.existsSync(filepath)) {
          const crypto = await import('crypto');
          const urlHash = crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
          filename = `${filename}_${urlHash}`;
          this.logger.info(`File exists, using unique filename: ${filename}.md`);
        }
        
        this.markdownGenerator.saveToFile(
          markdown,
          filename,
          this.pagesDir
        );
      }
      
      if (pageData.skipDefaultMarkdownOutput) {
        this.logger.info('Saved: Tsanghi per-menu markdown files');
      } else {
        this.statsTracker.incrementFilesGenerated();
        this.logger.info(`Saved: ${filename}.md`);
      }

      // Close page
      await page.close();

      // Update link status to fetched
      this.linkManager.updateLinkStatus(url, 'fetched');
      this.linkManager.saveLinks(this.linksFile, this.linkManager.links);

      return true;
    } catch (error) {
      this.logError(url, error);

      // Increment retry count
      const retryCount = this.linkManager.incrementRetryCount(url);
      
      if (retryCount < maxRetries) {
        // Not reached max retries, set back to unfetched for next run
        this.logger.warn(`Retry ${retryCount}/${maxRetries}, setting back to unfetched`);
        this.linkManager.updateLinkStatus(url, 'unfetched');
      } else {
        // Reached max retries, mark as failed
        this.logger.error(`Failed after ${maxRetries} retries, marking as failed`);
        this.linkManager.updateLinkStatus(url, 'failed', error.message);
      }
      
      this.linkManager.saveLinks(this.linksFile, this.linkManager.links);
      return false;
    }
  }

  /**
   * Log progress
   * @param {number} current - Current progress
   * @param {number} total - Total count
   */
  logProgress(current, total) {
    const percentage = ((current / total) * 100).toFixed(1);
    this.logger.info(`Progress: ${current}/${total} (${percentage}%)`);
  }

  /**
   * Log error
   * @param {string} url - URL that caused error
   * @param {Error} error - Error object
   */
  logError(url, error) {
    this.logger.error(`Error processing ${url}`, error);
  }

  /**
   * Generate statistics
   * @returns {Object} Statistics object
   */
  generateStats() {
    return this.statsTracker.getStats();
  }

  /**
   * Display statistics
   * @param {Object} stats - Statistics object
   */
  displayStats(stats) {
    this.logger.info('=== Crawling Statistics ===');
    this.logger.info(`Total URLs: ${stats.totalUrls}`);
    this.logger.info(`Crawled: ${stats.crawledUrls}`);
    this.logger.info(`Failed: ${stats.failedUrls}`);
    this.logger.info(`New Links Found: ${stats.newLinksFound}`);
    this.logger.info(`Files Generated: ${stats.filesGenerated}`);
    this.logger.info(`Duration: ${stats.duration}s`);
  }

  /**
   * Sleep utility
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default CrawlerMain;
