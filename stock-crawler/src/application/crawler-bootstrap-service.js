import fs from 'fs';
import ConfigManager from '../config-manager.js';
import LinkManager from '../link-manager.js';
import BrowserManager from '../browser-manager.js';
import LoginHandler from '../login-handler.js';
import LinkFinder from '../link-finder.js';
import PageParser from '../page-parser.js';
import MarkdownGenerator from '../parsers/markdown-generator.js';
import Logger from '../logger.js';
import StatsTracker from '../stats-tracker.js';
import PageStorage from '../storage/page-storage.js';
import LLMDataExtractor from '../parsers/llm-data-extractor.js';
import CrawlJobService from './crawl-job-service.js';
import UrlProcessingService from './url-processing-service.js';
import MetricsAdapter from '../infrastructure/metrics-adapter.js';

class CrawlerBootstrapService {
  async initialize(configPath) {
    const configManager = new ConfigManager();
    const config = configManager.loadConfig(configPath);

    const projectDir = `${config.output.directory}/${config.name}`;
    const logsDir = `${projectDir}/logs`;
    const linksFile = `${projectDir}/links.txt`;

    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logger = new Logger(logsDir, config.crawler.logLevel || 'INFO');
    const statsTracker = new StatsTracker();

    const timestamp = logger.getTimestamp();
    const isLixinger = config.name && config.name.startsWith('lixinger');
    const pagesDir = isLixinger ? `${projectDir}/data` : `${projectDir}/pages-${timestamp}`;
    if (!fs.existsSync(pagesDir)) {
      fs.mkdirSync(pagesDir, { recursive: true });
    }

    logger.info(`Loaded configuration: ${config.name}`);

    const linkManager = new LinkManager();
    linkManager.loadLinks(linksFile);
    logger.info(`Loaded ${linkManager.links.length} links from ${linksFile}`);

    if (linkManager.links.length === 0 && config.seedUrls && config.seedUrls.length > 0) {
      logger.info(`Initializing with ${config.seedUrls.length} seed URLs`);
      config.seedUrls.forEach(url => {
        linkManager.addLink(url, 'unfetched');
      });
      linkManager.saveLinks(linksFile, linkManager.links);
    }

    const browserManager = new BrowserManager();
    const loginHandler = new LoginHandler();
    const linkFinder = new LinkFinder();
    const pageParser = new PageParser();
    const markdownGenerator = new MarkdownGenerator();
    const pageStorage = new PageStorage(config, logger);
    await pageStorage.initialize(projectDir);
    const llmDataExtractor = new LLMDataExtractor(config.llmExtraction || {}, logger);
    const crawlJobService = new CrawlJobService({
      linkManager,
      config
    });
    const urlProcessingService = new UrlProcessingService(
      linkManager,
      logger,
      config.crawler.maxRetries || 3
    );
    const metricsAdapter = new MetricsAdapter(logger);

    logger.info(`Project directory: ${projectDir}`);
    logger.info(`Pages directory: ${pagesDir}`);
    logger.info(`Logs directory: ${logsDir}`);
    logger.info('Crawler initialized successfully');

    return {
      config,
      projectDir,
      logsDir,
      linksFile,
      pagesDir,
      logger,
      statsTracker,
      linkManager,
      browserManager,
      loginHandler,
      linkFinder,
      pageParser,
      markdownGenerator,
      pageStorage,
      llmDataExtractor,
      crawlJobService,
      urlProcessingService,
      metricsAdapter
    };
  }
}

export default CrawlerBootstrapService;
