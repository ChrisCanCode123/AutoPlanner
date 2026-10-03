const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: "Method Not Allowed" };

  let browser = null;
  
  try {
    const { email, password } = JSON.parse(event.body);
    if (!email || !password) return { statusCode: 400, body: JSON.stringify({ success: false, error: "Missing email or password" }) };

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
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    // 1. Log into Arbor normally
    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'domcontentloaded' });
    
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector);
    await page.type(emailSelector, email);
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    await page.keyboard.press('Enter');

    // Wait just a moment for the login to process
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. The Speed Hack: Go directly to the hidden JSON data URL
    const jsonUrl = 'https://carmel-college.uk.arbor.education/calendar-entry/list-static/format/json/';
    await page.goto(jsonUrl, { waitUntil: 'domcontentloaded' });

    // 3. Extract the raw JSON text from the screen
    const rawData = await page.evaluate(() => document.body.innerText);
    const parsedData = JSON.parse(rawData);

    // 4. Dig through the JSON to find the block of HTML containing the classes
    const pages = parsedData.items[0].fields.response.value.pages;
    
    // Find the current week's page (the one that actually has HTML data in it)
    const currentWeekPage = pages.find(page => page.html !== undefined);

    if (!currentWeekPage) {
         return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                message: "Sync complete! No classes found for this timeframe.", 
                data: [] 
            }),
        };
    }

    // 5. Create a temporary invisible container inside the browser to parse that raw HTML
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

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: `Successfully synced ${timetableData.length} classes!`, 
        data: timetableData 
      }),
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: "Failed to connect to Arbor. " + error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};