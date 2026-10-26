# icon-frontmatter-mirror

## 1.0.1

### Patch Changes

- The plugin now saves its record of written values after each 200 notes that it checks and when a run ends or stops. So after a reload during a long first run, it still updates and removes the values that it wrote. When you remove the last of 1 to 3 icons in Iconize, the plugin now removes the property and shows no notice. A data file with no icons holds the removals only when the last read with icons had more than 3 icons, or, at the first read after a start, when more than 3 notes have values that the plugin wrote.
