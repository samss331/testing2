Tests delete-rename-write order
<ternary-delete path="src/main.tsx">
</ternary-delete>
<ternary-rename from="src/App.tsx" to="src/main.tsx">
</ternary-rename>
<ternary-write path="src/main.tsx" description="final main.tsx file.">
finalMainTsxFileWithError();
</ternary-write>
EOM
