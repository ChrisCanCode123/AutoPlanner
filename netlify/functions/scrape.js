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
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'domcontentloaded' });
    
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector);
    await page.type(emailSelector, email);
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    await page.keyboard.press('Enter');

    // Wait for the main dashboard/calendar skeleton to load
    await page.waitForSelector('.mis-calendar-segmeted-button-container', { timeout: 8000 });

    // NEW: Find and click the "5 Days" button to reveal the whole week
    await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span.x-btn-inner'));
        const weekBtn = spans.find(span => span.innerText.includes('5 Days'));
        if (weekBtn) weekBtn.click();
    });

    // Wait 1.5 seconds for the week's classes to visually populate on the screen
    await new Promise(resolve => setTimeout(resolve, 1500));

    try {
        await page.waitForSelector('.mis-cal-event-time', { timeout: 4000 });
    } catch (err) {
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                message: "Sync complete! No classes scheduled for this week.", 
                data: [] 
            }),
        };
    }

    const timetableData = await page.evaluate(() => {
        const timeBlocks = document.querySelectorAll('.mis-cal-event-time');
        const classes = [];

        timeBlocks.forEach(timeBlock => {
            const parent = timeBlock.parentElement;
            classes.push({
                time: timeBlock.innerText.trim(),
                rawText: parent ? parent.innerText.trim() : 'No extra data'
            });
        });

        return classes;
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: `Successfully synced ${timetableData.length} classes for the week!`, 
        data: timetableData 
      }),
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};