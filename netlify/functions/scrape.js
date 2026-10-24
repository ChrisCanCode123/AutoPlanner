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
        // Block heavy resources so the script finishes well before Netlify's 10-second timeout limit
        if (['image', 'stylesheet', 'font', 'media', 'script'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    // Use fast domcontentloaded instead of slow networkidle2
    await page.goto('https://login.arbor.sc/', { waitUntil: 'domcontentloaded' });
    await page.type('input[type="text"], input[type="email"], input[name="username"]', email);
    await page.type('input[type="password"]', password);
    
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.keyboard.press('Enter')
    ]);

    if (page.url().includes('login')) return { statusCode: 401, body: JSON.stringify({ success: false, error: "Invalid email or password." }) };

    await page.goto('https://carmel-college.uk.arbor.education/?/my-mis-ui/calendar/', { waitUntil: 'domcontentloaded' });

    const scrapeCurrentView = async () => {
        // Wait up to 3 seconds for calendar dates to appear, silently continue if empty (Holiday)
        await page.waitForSelector('.mis-calendar-date', { timeout: 3000 }).catch(() => {});
        
        return await page.evaluate(async () => {
            const pageText = document.body.innerText;
            const weekMatch = pageText.match(/\(Week\s*([A-B])\)/i);
            const weekLabel = weekMatch ? `Week ${weekMatch[1].toUpperCase()}` : "Week A";

            const headers = Array.from(document.querySelectorAll('thead .mis-calendar-date'));
            const dayNames = headers.map(th => th.innerText.replace(/\n/g, ' ').trim());
            const dayColumns = Array.from(document.querySelectorAll('tbody tr:first-child > td')).slice(1);
            const schedule = [];
            const fetchPromises = [];

            dayColumns.forEach((col, index) => {
                const dayName = dayNames[index] || `Day ${index + 1}`;
                const events = col.querySelectorAll('.mis-cal-event');
                const classes = [];
                const seen = new Set();

                events.forEach(event => {
                    const timeEl = event.querySelector('.mis-cal-event-time');
                    const titleEl = event.querySelector('.title');
                    const ajaxLink = event.getAttribute('ajax-link');
                    
                    if (timeEl && titleEl) {
                        const timeString = timeEl.innerText.trim();
                        const rawText = titleEl.innerText.trim();
                        const times = timeString.split('-');
                        if (times.length === 2 && times[0] === times[1]) return;

                        const uniqueId = timeString + rawText;
                        if (!seen.has(uniqueId)) {
                            seen.add(uniqueId);
                            const classData = { time: timeString, rawText: rawText, teacher: null, room: null };
                            classes.push(classData);

                            if (ajaxLink) {
                                fetchPromises.push(fetch(ajaxLink).then(res => res.text()).then(html => {
                                    const doc = new DOMParser().parseFromString(html, 'text/html');
                                    const listItems = Array.from(doc.querySelectorAll('li'));
                                    const staffLi = listItems.find(li => li.querySelector('b') && li.querySelector('b').innerText.includes('Staff'));
                                    if (staffLi && staffLi.querySelector('span')) classData.teacher = staffLi.querySelector('span').innerText.trim();
                                    const roomLi = listItems.find(li => li.querySelector('b') && (li.querySelector('b').innerText.includes('Room') || li.querySelector('b').innerText.includes('Location')));
                                    if (roomLi && roomLi.querySelector('span')) classData.room = roomLi.querySelector('span').innerText.trim();
                                }).catch(e => console.error(e)));
                            }
                        }
                    }
                });
                
                if (classes.length > 0) classes.sort((a, b) => a.time.localeCompare(b.time));
                
                schedule.push({ 
                    day: dayName, 
                    weekLabel: weekLabel, 
                    isHoliday: classes.length === 0,
                    classes: classes 
                });
            });
            await Promise.all(fetchPromises);
            return schedule;
        });
    };

    // Scrape Week 1
    const week1 = await scrapeCurrentView();
    
    // Click Next Week and Scrape Week 2
    const nextBtn = await page.$('.mis-calendar-navigation-button-next');
    if (nextBtn) {
        await nextBtn.click();
        // Safe, native JS timeout replacement for deprecated puppeteer functions
        await new Promise(resolve => setTimeout(resolve, 1500)); 
        const week2 = await scrapeCurrentView();
        week1.push(...week2);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, message: `Successfully synced!`, data: week1 }) };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message || error.toString() }) };
  } finally {
    if (browser !== null) { await browser.close(); }
  }
};