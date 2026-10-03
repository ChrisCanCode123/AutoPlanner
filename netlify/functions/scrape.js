const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: "Method Not Allowed" };

  const startTime = Date.now();
  const logTime = (step) => console.log(`[${Date.now() - startTime}ms] ${step}`);

  let browser = null;
  
  try {
    const { email, password } = JSON.parse(event.body);
    
    logTime("Starting browser boot sequence...");
    const chromium = (await import('@sparticuz/chromium')).default;
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    
    logTime("Browser booted. Loading Arbor login page...");
    const page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'domcontentloaded' });
    
    logTime("Login page loaded. Typing credentials...");
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector);
    await page.type(emailSelector, email);
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    logTime("Pressing enter to log in...");
    await page.keyboard.press('Enter');

    logTime("Waiting 2 seconds for Arbor servers to authenticate...");
    await new Promise(resolve => setTimeout(resolve, 2000));

    logTime("Fetching raw JSON calendar data...");
    const jsonUrl = 'https://carmel-college.uk.arbor.education/calendar-entry/list-static/format/json/';
    await page.goto(jsonUrl, { waitUntil: 'domcontentloaded' });

    logTime("Extracting data from page...");
    const rawData = await page.evaluate(() => document.body.innerText);

    logTime("Success! Closing browser.");
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: "Check Netlify logs for timing!", data: [] }),
    };

  } catch (error) {
    logTime(`CRASHED: ${error.message}`);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};