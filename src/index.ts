import { Schema, Context, h, Session } from 'koishi'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlink, writeFile } from 'node:fs/promises'
import { } from 'koishi-plugin-ffmpeg'
import { parseGIF, decompressFrames } from 'gifuct-js'
import { promises as fsPromises } from 'node:fs';
const { readFile } = fsPromises;

export const name = 'gif-reverse'
export const inject = {
  required: ['http', 'i18n', 'logger', 'ffmpeg']
}
export const usage = `
---

<table>
<thead>
<tr>
<th>选项</th>
<th>简写</th>
<th>描述</th>
<th>类型</th>
<th>默认值</th>
</tr>
</thead>
<tbody>
<tr>
<td><code>--rebound</code></td>
<td><code>-b</code></td>
<td>回弹播放 GIF</td>
<td><code>boolean</code></td>
<td></td>
</tr>
<tr>
<td><code>--reverse</code></td>
<td><code>-r</code></td>
<td>倒放 GIF</td>
<td><code>boolean</code></td>
<td></td>
</tr>
<tr>
<td><code>--speed</code></td>
<td><code>-s</code></td>
<td>改变播放速度 (大于 1 为加速，小于则为减速)</td>
<td><code>number</code></td>
<td><code>1</code></td>
</tr>
<tr>
<td><code>--slide</code></td>
<td><code>-l</code></td>
<td>滑动方向 (上/下/左/右)</td>
<td><code>string</code></td>
<td></td>
</tr>
<tr>
<td><code>--rotate</code></td>
<td><code>-o</code></td>
<td>旋转方向 (顺/逆)</td>
<td><code>string</code>
</tr>
<tr>
<td><code>--mirror</code></td>
<td><code>-m</code></td>
<td>翻转方向 (上/下/左/右)</td>
<td><code>string</code></td>
<td></td>
</tr>
</tbody>
</table>

---

<h2>使用示例</h2>

<ul>
<li><strong>倒放 GIF:</strong>
<pre><code>gif -r</code></pre>
</li>
<li><strong>两倍速右滑 GIF:</strong>
<pre><code>gif -s 2 -l 右</code></pre>
</li>
<li><strong>向左翻转 GIF:</strong>
<pre><code>gif -m 左</code></pre>
</li>
<li><strong>逆时针旋转 GIF:</strong>
<pre><code>gif -o 逆</code></pre>
</li>
</ul>

---

请确保 'http', 'i18n', 'logger', 'ffmpeg' 服务均可用！

speed加速/减速太多可能会导致效果不明显。
`;

export const Config =
  Schema.intersect([
    Schema.object({
      gifCommand: Schema.string().default("gif-reverse").description("注册的指令名称"),
      waitTimeout: Schema.number().default(50).description("等待用户输入图片的最大时间（秒）"),
    }).description('基础设置'),
    Schema.object({
      usedReverse: Schema.boolean().default(true).description("开启后，在不指定选项时，默认使用`倒放`效果。<br>关闭后，在不指定选项时，执行`-h`选项查看帮助"),
    }).description('进阶设置'),
    Schema.object({
      loggerinfo: Schema.boolean().default(false).description("日志调试模式"),
    }).description('开发者选项'),
  ])

export function apply(ctx: Context, config) {
  const TMP_DIR = tmpdir()
  const logger = ctx.logger('gif-reverse')
  function logInfo(...args: any[]) {
    if (config.loggerinfo) {
      (logger.info as (...args: any[]) => void)(...args);
    }
  }
  // 获取图片 URL 的新函数
  function getImageURL(session: Session): string | undefined {
    const quoteImage = h.select(session.quote?.content, "img").map((a) => a.attrs.src)[0];
    const contentImage = h.select(session.content, "img").map((a) => a.attrs.src)[0];
    return quoteImage || contentImage;
  }

  ctx.i18n.define("zh-CN", {
    commands: {
      [config.gifCommand]: {
        arguments: {
          gif: "图片消息",
        },
        description: "GIF 图片处理",
        messages: {
          "invalidFFmpeg": "没有安装 FFmpeg 服务！",
          "invalidPTS": "播放速度必须大于 0",
          "waitprompt": "在 {0} 秒内发送想要处理的 GIF",
          "invalidimage": "未检测到图片输入。",
          "invalidGIF": "无法处理非 GIF 图片。",
          "generatefailed": "图片生成失败。",
          "invalidDirection": "无效的方向参数，请选择：左、右、上、下",
          "invalidRotation": "无效的旋转方向，请选择：顺、逆",
          "invalidMirror": "无效的翻转方向，请选择：上、下、左、右",
        },
        options: {
          help: "查看指令帮助",
          rebound: "回弹效果（正放+倒放）",
          reverse: " 倒放 GIF",
          speed: " 改变播放速度 (大于 1 为加速，小于则为减速)",
          slide: "滑动方向 (上/下/左/右)",
          rotate: "旋转方向 (顺/逆)",
          mirror: "翻转方向 (上/下/左/右)",
        }
      },
    }
  });

  ctx.command(`${config.gifCommand} [gif:image]`)
    .option('rebound', '-b, --rebound', { type: 'boolean' })
    .option('reverse', '-r, --reverse', { type: 'boolean' })
    .option('speed', '-s <times:number>', { type: 'number', fallback: 1 })
    .option('slide', '-l <direction:string>', { type: 'string' })
    .option('rotate', '-o <direction:string>', { type: 'string' })
    .option('mirror', '-m <direction:string>', { type: 'string' })
    .example(`倒放：${config.gifCommand} -r`)
    .example(`两倍速右滑：${config.gifCommand} -s 2 -l 右`)
    .example(`向左翻转：${config.gifCommand} -m 左`)
    .example(`逆时针旋转：${config.gifCommand} -o 逆`)
    .action(async ({ session, options }, gif) => {
      let { reverse, rebound, speed, slide, rotate, mirror } = options
      logInfo(options)
      if (!ctx.ffmpeg) return session.text(".invalidFFmpeg")
      if (Object.keys(options).length === 1 && options.speed === 1) { // speed 始终存在，且默认值为1，需要忽略判断
        if (config.usedReverse) {
          reverse = true
        } else {
          await session.execute(`${config.gifCommand} -h`)
          return
        }
      }
      if (speed <= 0) return session.text(".invalidPTS")

      let src = gif?.src || getImageURL(session)
      
      if (!src) {
        const [msgId] = await session.send(session.text(".waitprompt", [config.waitTimeout]))
        const content = await session.prompt(config.waitTimeout * 1000)
        if (content !== undefined) {
          src = h.select(content, 'img')[0]?.attrs.src ?? h.select(content, 'mface')[0]?.attrs.url
        }
        try {
          session.bot.deleteMessage(session.channelId, msgId)
        } catch { }
      }

      const quote = h.quote(session.messageId)
      if (!src) return `${quote}${session.text(".invalidimage")}`

      const file = await ctx.http.file(src)
      logInfo(file)
      if (!['image/gif', 'application/octet-stream', 'video/mp4'].includes(file.type)) {
        return `${quote}${session.text(".invalidGIF")}`
      }

      const path = join(TMP_DIR, `gif-reverse-${Date.now()}`)
      await writeFile(path, Buffer.from(file.data))

      let vf = ''
      const filters: string[] = []

      // 获取 GIF 信息
      let gifDuration = 0;
      let fps = 20; // 默认帧率
      try {
        const gifData = await readFile(path);
        const gif = parseGIF(gifData);
        const frames = decompressFrames(gif, true);
        gifDuration = frames.map(frame => frame.delay).reduce((a, b) => a + b, 0) / 1000; // 转换为秒
        // 计算帧率
        if (frames.length > 0 && gifDuration > 0) {
          fps = frames.length / gifDuration;
        }
        logInfo(`GIF 帧率: ${fps}`);
      } catch (error) {
        logger.error("解析 GIF 时发生错误:", error);
        return `${quote}${session.text(".generatefailed")}`;
      }

      let totalDuration = gifDuration;

      // 应用 slide 效果 (必须在 speed 之前)
      if (slide) {
        try {
          const outputDuration = totalDuration; // 滑动效果不改变总时长
          const totalFrames = Math.ceil(outputDuration * fps); // 向上 取整
          logInfo(`输出时长: ${outputDuration}`);
          let slideFilter = '';
          switch (slide) {
            case '左':
              slideFilter = `split[a][b];[a][b]hstack[tiled];[tiled]crop=iw/2:ih:x='t*(iw/2)/${outputDuration}':y=0,setpts=PTS-STARTPTS`;
              break;
            case '右':
              slideFilter = `split[a][b];[a][b]hstack[tiled];[tiled]crop=iw/2:ih:x='iw/2 - t*(iw/2)/${outputDuration}':y=0,setpts=PTS-STARTPTS`;
              break;
            case '上':
              slideFilter = `split[a][b];[a][b]vstack[tiled];[tiled]crop=iw:ih/2:x=0:y='t*(ih/2)/${outputDuration}',setpts=PTS-STARTPTS`;
              break;
            case '下':
              slideFilter = `split[a][b];[a][b]vstack[tiled];[tiled]crop=iw:ih/2:x=0:y='ih/2 - t*(ih/2)/${outputDuration}',setpts=PTS-STARTPTS`;
              break;
            default:
              return `${quote}${session.text(".invalidDirection")}`;
          }
          filters.push(slideFilter);
          logInfo(`应用${slide}方向滑动效果，总帧数: ${totalFrames}`);
        } catch (error) {
          logger.error("解析 GIF 时发生错误:", error);
          return `${quote}${session.text(".generatefailed")}`; // 或者返回一个更具体的错误消息
        }
      }

      // 回弹效果处理
      if (rebound) {
        totalDuration = gifDuration * 2 / speed; // 总时长为原时长两倍
        filters.push(
          '[0]split[main][back];' +
          '[back]reverse[reversed];' +
          '[main][reversed]concat=n=2:v=1'
        );
      } else if (reverse) {
        filters.push('reverse');
      }

      // 应用 speed 效果
      if (speed !== 1) {
        filters.push(`setpts=PTS/${speed}`); // 调整时间戳实现变速
        fps = fps * speed; // 调整输出帧率
        logInfo(`应用变速效果，速度: ${speed}，调整后帧率: ${fps}`);
      }

      if (rotate) {
        let rotateAngle = ''
        switch (rotate) {
          case '顺':
            rotateAngle = `rotate=${360 / gifDuration}*t*PI/180:fillcolor=0x00000000`
            logInfo(`应用顺时针旋转效果, 旋转速度: ${360 / gifDuration} 度/秒`)
            break
          case '逆':
            rotateAngle = `rotate=-${360 / gifDuration}*t*PI/180:fillcolor=0x00000000`
            logInfo(`应用逆时针旋转效果, 旋转速度: ${360 / gifDuration} 度/秒`)
            break
          default:
            return `${quote}${session.text(".invalidRotation")}`
        }
        filters.push(rotateAngle)
      }

      if (mirror) {
        let mirrorEffect = ''
        switch (mirror) {
          case '上':
          case '下':
            mirrorEffect = 'vflip'
            logInfo(`应用上下翻转效果`)
            break
          case '左':
          case '右':
            mirrorEffect = 'hflip'
            logInfo(`应用左右翻转效果`)
            break
          default:
            return `${quote}${session.text(".invalidMirror")}`
        }
        filters.push(mirrorEffect)
      }

      filters.push('split[s0][s1];[s0]palettegen=stats_mode=full:reserve_transparent=on[p];[s1][p]paletteuse=new=1:dither=none')
      vf = filters.filter(f => f).join(',')

      const builder = ctx.ffmpeg.builder().input(path)
      builder.outputOption('-r', String(fps), '-loop', '0'); // 使用获取到的帧率

      if (vf) {
        logInfo(`使用的滤镜: ${vf}`)
        builder.outputOption('-filter_complex', vf, '-f', 'gif')
      } else {
        builder.outputOption('-f', 'gif')
      }

      let buffer
      try {
        buffer = await builder.run('buffer')
      } catch (e) {
        logger.error('FFmpeg 执行失败', e)
        unlink(path)
        return `${quote}${session.text(".generatefailed")}`
      }

      unlink(path)

      if (buffer.length === 0) {
        logger.error('FFmpeg 返回空 buffer')
        return `${quote}${session.text(".generatefailed")}`
      }
      logInfo(`GIF 处理成功，选项: ${JSON.stringify(options)}`)
      return [quote, h.img(buffer, 'image/gif')]
    })
}
