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
    
    const page = await browser.newPage();
    
    // Block heavy files to speed up the boot sequence
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    logTime("Loading standard Arbor login page...");
    // FIX: Go to the reliable base login URL instead of the calendar deep link
    await page.goto('https://carmel-college.uk.arbor.education/', { waitUntil: 'networkidle2' });
    
    logTime("Login page loaded. Typing credentials...");
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector, { timeout: 10000 });
    await page.type(emailSelector, email);
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    logTime("Pressing enter to log in...");
    await page.keyboard.press('Enter');

    logTime("Waiting for Arbor servers to authenticate...");
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    logTime("Fetching raw JSON calendar data...");
    const jsonUrl = 'https://carmel-college.uk.arbor.education/calendar-entry/list-static/format/json/';
    await page.goto(jsonUrl, { waitUntil: 'domcontentloaded' });

    logTime("Extracting data from page...");
    const rawData = await page.evaluate(() => document.body.innerText);
    const parsedData = JSON.parse(rawData);

    // Dig through the JSON to find the block of HTML containing the classes
    const pages = parsedData.items[0].fields.response.value.pages;
    const currentWeekPage = pages.find(p => p.html !== undefined);

    if (!currentWeekPage) {
        logTime("No classes found this week.");
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: "No classes found for this timeframe.", data: [] }),
        };
    }

    logTime("Parsing HTML block from JSON...");
    const timetableData = await page.evaluate((htmlString) => {
        const div = document.createElement('div');
        div.innerHTML = htmlString;
        
        const events = div.querySelectorAll('.mis-cal-event');
        const classes = [];

        events.forEach(event => {
            const timeEl = event.querySelector('.mis-cal-event-time');
            const titleEl = event.querySelector('.title');
            
            if (timeEl && titleEl) {
                classes.push({
                    time: timeEl.innerText.trim(),
                    rawText: titleEl.innerText.trim()
                });
            }
        });

        return classes;
    }, currentWeekPage.html);

    logTime(`Success! Extracted ${timetableData.length} classes.`);
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: `Successfully synced ${timetableData.length} classes!`, 
        data: timetableData 
      }),
    };

  } catch (error) {
    logTime(`CRASHED: ${error.message}`);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: "Scraper failed: " + error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};