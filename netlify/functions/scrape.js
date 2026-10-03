const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  let browser = null;
  
  try {
    // 1. Dynamically import the chromium package
    const chromium = (await import('@sparticuz/chromium')).default;

    // 2. Boot up the serverless browser
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // 3. Navigate to the Arbor login page
    await page.goto('https://login.arbor.sc/', { waitUntil: 'domcontentloaded' });
    
    // 4. Grab the title of the webpage to prove we got there
    const pageTitle = await page.title();

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: "Browser reached Arbor successfully!", 
        title: pageTitle 
      }),
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  } finally {
    if (browser !== null) {
      await browser.close();
    }
  }
};