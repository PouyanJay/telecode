import { expect, test } from '@playwright/test';

test('echoes a string through the full stack (browser -> relay -> daemon -> browser)', async ({
  page,
}) => {
  await page.goto('/');

  // The page connects to the relay on load.
  await expect(page.getByTestId('status')).toHaveText('connected');

  await page.getByTestId('echo-input').fill('hello-e2e');
  await page.getByTestId('echo-send').click();

  await expect(page.getByTestId('echo-reply')).toHaveText('hello-e2e');
});
