// Organisation-specific credential formats supplement Secretlint's maintained preset.
// Never put the matched credential in a message or exported finding.
const messages={hardcoded:{en:()=>"发现硬编码飞书机器人凭据地址，请撤销泄露地址并使用受控环境引用。"}};
export const creator = {
  messages,
  meta: { id: "wl/feishu-webhook", type: "scanner", recommended: true, supportedContentTypes: ["text"] },
  create(context) {
    const translate=context.createTranslator(messages);
    return {
      file(source) {
        const pattern =
          /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
        for (const match of source.content.matchAll(pattern))
          context.report({
            message: translate("hardcoded"),
            range: [match.index, match.index + match[0].length],
          });
      },
    };
  },
};
