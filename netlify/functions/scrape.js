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
    
    // SPEED BOOST 1: Block all images, stylesheets, and fonts from loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    // SPEED BOOST 2: Go straight to the calendar. Arbor will ask for login, then auto-return here.
    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'domcontentloaded' });
    
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector);
    await page.type(emailSelector, email);
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    // Hit enter to log in
    await page.keyboard.press('Enter');

    // SPEED BOOST 3: Wait specifically for the class blocks to appear, skipping the network idle wait
    await page.waitForSelector('.mis-cal-event-time', { timeout: 8000 });

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
        message: `Successfully synced ${timetableData.length} classes!`, 
        data: timetableData 
      }),
    };

  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};