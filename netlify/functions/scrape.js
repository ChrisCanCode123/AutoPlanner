const puppeteer = require('puppeteer-core');

exports.handler = async (event, context) => {
  // 1. Block any requests that aren't sending data (POST requests)
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let browser = null;
  
  try {
    // 2. Extract the email and password sent from your frontend form
    const { email, password } = JSON.parse(event.body);

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: "Missing email or password" })
      };
    }

    const chromium = (await import('@sparticuz/chromium')).default;

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    // 3. Navigate to the generic Arbor login URL 
    await page.goto('https://login.arbor.sc/', { waitUntil: 'domcontentloaded' });
    
    // 4. Wait for the email field to appear, then type the email
    // Puppeteer uses standard CSS selectors to find elements
    const emailSelector = 'input[type="text"], input[type="email"], input[name="username"]';
    await page.waitForSelector(emailSelector);
    await page.type(emailSelector, email);
    
    // 5. Wait for the password field and type the password
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector);
    await page.type(passwordSelector, password);

    // 6. Click the login button
    // 6. Press the Enter key to submit the form
    await page.keyboard.press('Enter');

    // 7. Wait for the page to finish redirecting after clicking login
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 8. Verify the login by checking if we are still on the login screen
    const currentUrl = page.url();
    const pageTitle = await page.title();

    if (currentUrl.includes('login')) {
       // If the URL still says "login", Arbor rejected the credentials
       return {
         statusCode: 401,
         body: JSON.stringify({ success: false, error: "Invalid email or password." })
       };
    }

    // If we made it here, the login worked!
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        message: "Successfully logged into Arbor Dashboard!", 
        url: currentUrl,
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