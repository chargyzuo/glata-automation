# 告警恢复状态判断存档

默认批量入口为 `Alarm_recovered`（viewId=49787），不重复读取或判断 Alert Status。最新单号入口已恢复这项检查，并直接复用本文件中的旧函数。

`alert-status.mjs` 保留原逻辑供将来显式复用：

- `isAlertRecovered(status)`：清理空白、零宽字符后，精确判断是否为 `Recovered`。
- `readAlertStatus(page)`：读取当前 Details 面板的 Alert Status；缺失或重复标签时抛错。
- `checkAlertRecovered(page)`：读取并返回恢复状态判断结果。

```js
import { checkAlertRecovered } from './archive/alert-status.mjs';
const recovered = await checkAlertRecovered(page);
```

单号入口在首次判断和提交前复查时显式使用 `readAlertStatus` 和 `isAlertRecovered`。批量分支不调用这些函数。已解决工单的结果核验也不依赖告警字段。
