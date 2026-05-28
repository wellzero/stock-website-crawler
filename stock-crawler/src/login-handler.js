/**
 * Login Handler Module
 * 
 * Handles login detection and automatic login for websites that require authentication.
 * Supports multiple login form formats (phone, email, username).
 */

class LoginHandler {
  /**
   * Check if the current page is a login page
   * @param {Page} page - Playwright page object
   * @returns {Promise<boolean>} True if login is needed
   */
  async needsLogin(page) {
    try {
      // Strategy 1: Check URL for login keywords
      const url = page.url();
      if (url.includes('login') || url.includes('signin') || url.includes('auth')) {
        return true;
      }

      // Strategy 2: Check for password input field
      const passwordCount = await page.locator('input[type="password"]').count();
      if (passwordCount > 0) {
        return true;
      }

      // Strategy 3: Check for login button
      const loginButtonCount = await page.locator('button:has-text("登录"), button:has-text("登錄"), button:has-text("Login"), button:has-text("Sign in")').count();
      if (loginButtonCount > 0) {
        return true;
      }

      // Strategy 4: Check for login form
      const loginFormCount = await page.locator('form[action*="login"], form[action*="signin"]').count();
      if (loginFormCount > 0) {
        return true;
      }

      // Strategy 5: Check for common login container classes
      const loginContainerCount = await page.locator('.login-form, .signin-form, #login, #signin, [class*="login"], [class*="signin"]').count();
      if (loginContainerCount > 0) {
        // Verify it actually contains login elements
        const hasPasswordField = await page.locator('.login-form input[type="password"], .signin-form input[type="password"], #login input[type="password"], #signin input[type="password"]').count();
        if (hasPasswordField > 0) {
          return true;
        }
      }

      return false;
    } catch (error) {
      // If there's an error checking, assume no login needed
      return false;
    }
  }

  /**
   * Execute automatic login
   * @param {Page} page - Playwright page object
   * @param {Object} credentials - Login credentials {username, password}
   * @returns {Promise<boolean>} True if login succeeded
   */
  async login(page, credentials) {
    try {
      const { username, password } = credentials;

      // Fill username
      await this.fillUsername(page, username);

      // Fill password
      await this.fillPassword(page, password);

      // Get current URL before clicking login
      const urlBeforeLogin = page.url();

      // Click login button
      await this.clickLoginButton(page);

      // Wait for navigation or content change (try multiple strategies)
      try {
        // Strategy 1: Wait for navigation
        await page.waitForNavigation({ timeout: 5000, waitUntil: 'domcontentloaded' }).catch(() => {});
      } catch (e) {
        // Navigation might not happen, that's ok
      }

      // Additional wait for any async operations
      await page.waitForTimeout(3000);

      // Check if still on login page
      const stillNeedsLogin = await this.needsLogin(page);
      
      if (!stillNeedsLogin) {
        return true;
      }

      // If URL changed, consider it a success even if we can't detect login state
      const urlAfterLogin = page.url();
      if (urlAfterLogin !== urlBeforeLogin && !urlAfterLogin.includes('login') && !urlAfterLogin.includes('signin')) {
        return true;
      }

      return false;
    } catch (error) {
      console.error('Login failed:', error.message);
      return false;
    }
  }

  /**
   * Find and fill username input field
   * Supports multiple input types: phone, email, username, text
   * @param {Page} page - Playwright page object
   * @param {string} username - Username to fill
   */
  async fillUsername(page, username) {
    // Try different selectors for username input
    const selectors = [
      'input[placeholder*="手机"]',
      'input[placeholder*="電話"]',
      'input[placeholder*="手机号"]',
      'input[placeholder*="账号"]',
      'input[placeholder*="帳號"]',
      'input[placeholder*="用户"]',
      'input[placeholder*="用戶"]',
      'input[placeholder*="邮箱"]',
      'input[placeholder*="郵箱"]',
      'input[placeholder*="phone"]',
      'input[placeholder*="Phone"]',
      'input[placeholder*="username"]',
      'input[placeholder*="Username"]',
      'input[placeholder*="email"]',
      'input[placeholder*="Email"]',
      'input[type="tel"]',
      'input[type="email"]',
      'input[name="phone"]',
      'input[name="mobile"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[name="account"]',
      // 优先选择登录表单内的输入框
      '.login-form input[type="text"]',
      '.login-form input',
      '[class*="login"] input[type="text"]',
      '[class*="login"] input',
      // Generic fallback
      'input[type="text"]'
    ];

    for (const selector of selectors) {
      try {
        const inputs = await page.locator(selector).all();
        for (const input of inputs) {
          try {
            // 跳过不可见或禁用的输入框
            const isVisible = await input.isVisible();
            const isEnabled = await input.isEnabled();
            if (!isVisible || !isEnabled) continue;

            // 跳过搜索框（通过 placeholder 判断）
            const placeholder = await input.getAttribute('placeholder') || '';
            if (placeholder.includes('搜索') || placeholder.includes('search') || placeholder.includes('Search')) {
              continue;
            }

            // 跳过 multiselect 输入框
            const className = await input.getAttribute('class') || '';
            if (className.includes('multiselect')) continue;

            await input.fill(username);
            return;
          } catch (e) {
            continue;
          }
        }
      } catch (error) {
        continue;
      }
    }

    // Last resort: try all visible inputs, skip search-like ones
    try {
      const allInputs = await page.locator('input').all();
      for (const input of allInputs) {
        try {
          const isVisible = await input.isVisible();
          if (!isVisible) continue;

          const placeholder = await input.getAttribute('placeholder') || '';
          if (placeholder.includes('搜索') || placeholder.includes('search')) continue;

          const className = await input.getAttribute('class') || '';
          if (className.includes('multiselect')) continue;

          const type = await input.getAttribute('type') || 'text';
          if (type === 'password' || type === 'hidden' || type === 'submit') continue;

          await input.fill(username);
          return;
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      // ignore
    }

    throw new Error('Could not find username input field');
  }

  /**
   * Find and fill password input field
   * @param {Page} page - Playwright page object
   * @param {string} password - Password to fill
   */
  async fillPassword(page, password) {
    const passwordInput = page.locator('input[type="password"]').first();
    const count = await passwordInput.count();
    if (count === 0) {
      throw new Error('Could not find password input field');
    }
    await passwordInput.fill(password);
  }

  /**
   * Find and click login button
   * @param {Page} page - Playwright page object
   */
  async clickLoginButton(page) {
    // Try different selectors for login button
    const selectors = [
      'button:has-text("登录")',
      'button:has-text("登 录")',
      'button:has-text("登錄")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("提交")',
      'button[type="submit"]',
      'input[type="submit"]',
      'a:has-text("登录")',
      'a:has-text("登錄")',
      'button[type="button"]:has-text("登录")'
    ];

    for (const selector of selectors) {
      try {
        const button = page.locator(selector).first();
        const count = await button.count();
        if (count > 0) {
          await button.click();
          return;
        }
      } catch (error) {
        // Continue to next selector
        continue;
      }
    }

    throw new Error('Could not find login button');
  }
}

export default LoginHandler;
