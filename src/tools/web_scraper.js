
import { chromium } from 'playwright';
import { DynamicTool } from '@langchain/core/tools';

async function scrapeUrl(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  const content = await page.content();
  await browser.close();
  return content;
}

export const createWebScraperTool = () => {
  return new DynamicTool({
    name: 'web_scraper',
    description: 'Scrapes the content of a given URL.',
    func: async (input) => {
      try {
        return await scrapeUrl(input);
      } catch (error) {
        return `Error scraping URL: ${error.message}`;
      }
    },
  });
};
