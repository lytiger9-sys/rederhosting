(() => {
  const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

  window.parseEnvironmentText = (source) => {
    const variables = [];
    const seen = new Set();
    const lines = String(source || "").replace(/^\uFEFF/, "").split(/\r?\n/);

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line || line.startsWith("#")) continue;

      const separator = line.indexOf("=");
      if (separator < 1) {
        return { variables: [], error: `${index + 1}번째 줄에 '='가 없습니다.` };
      }

      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (!keyPattern.test(key)) {
        return { variables: [], error: `${index + 1}번째 줄의 변수 이름이 올바르지 않습니다: ${key || "(빈 값)"}` };
      }
      if (seen.has(key)) {
        return { variables: [], error: `${index + 1}번째 줄에 중복된 변수 이름이 있습니다: ${key}` };
      }

      if (value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      if (value.includes("\0")) {
        return { variables: [], error: `${index + 1}번째 줄의 값에 사용할 수 없는 문자가 있습니다.` };
      }
      seen.add(key);
      variables.push({ key, value });
    }

    if (!variables.length) return { variables, error: "가져올 KEY=value 항목이 없습니다." };
    return { variables, error: "" };
  };
})();
