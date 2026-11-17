/**
 * 联机配置（Supabase）
 *
 * 1. 在 https://supabase.com 建一个免费项目；
 * 2. 打开项目 Settings → API，复制 Project URL 与 anon public key；
 * 3. 在项目 SQL Editor 里执行仓库根目录的 supabase/schema.sql；
 * 4. 把两个值填到下面，重新部署即可。
 *
 * anon key 是公开密钥，放在前端是安全的；真正的权限由 schema.sql 里的 RLS 策略控制。
 * 两项留空时，页面仍可玩双人同屏与人机，只是「联机对战」会提示未配置。
 */
export const SUPABASE_URL = 'https://buayeedlcgaijudandsy.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ1YXllZWRsY2dhaWp1ZGFuZHN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3ODA5ODIsImV4cCI6MjExMDM1Njk4Mn0.XOTlYAzwuej8Bk8PK2i9i4M4cqgMAA2fhyQaHDKcwHw';
