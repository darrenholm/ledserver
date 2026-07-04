-- Remote screenshot ("see what's on screen"). NovaStar's screen-capture is
-- async: we POST a request with a callback URL and VNNOX later POSTs the image
-- link back. screenshot_nonce ties a pending request to its callback; the
-- delivered image URL + time are stored for the device page to display.
ALTER TABLE devices ADD COLUMN screenshot_nonce TEXT;
ALTER TABLE devices ADD COLUMN last_screenshot_url TEXT;
ALTER TABLE devices ADD COLUMN last_screenshot_at TIMESTAMPTZ;
