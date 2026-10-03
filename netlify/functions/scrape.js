const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  let browser = null;
  
  try {
    // 1. Boot up the serverless browser
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // 2. Navigate to the Arbor login page
    await page.goto('https://login.arbor.sc/', { waitUntil: 'domcontentloaded' });
    
    // 3. Grab the title of the webpage to prove we got there
    const pageTitle = await page.title();

    // 4. Return the success message to your app
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: "Browser reached Arbor successfully!", 
        title: pageTitle 
      }),
    };

  } catch (error) {
    // If it crashes or times out, return the error
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  } finally {
    // Always close the browser to prevent memory leaks on the server
    if (browser !== null) {
      await browser.close();
    }
  }
};